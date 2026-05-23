const path = require('path');
const fs = require('fs');
const CameraDiscovery = require('./plugin/camera-discovery');
const RtspGrabber = require('./plugin/rtsp-grabber');
const ContainerRtspGrabber = require('./plugin/container-rtsp-grabber');
const Detector = require('./plugin/detector');
const GpsCalculator = require('./plugin/gps-calculator');
const SignalkOutput = require('./plugin/signalk-output');
const OpenCPNOutput = require('./plugin/opencpn-output');
const { assignTargetSlots } = require('./plugin/target-slots');
const { getAisStaticData } = require('./plugin/ais-target-data');
const { DEFAULT_CALIBRATION, normalizeCalibration } = require('./plugin/calibration');

const MODEL_PATH = path.join(__dirname, 'models', 'forward-watch.onnx');
const PUBLIC_PATH = path.join(__dirname, 'public');
const CALIBRATION_FILE = 'calibration.json';

module.exports = function(app) {
  const plugin = {
    id: 'signalk-forward-watch',
    name: 'Forward Watch',
    description: 'AI-powered forward watch obstacle detection for Signal K',

    schema: {
      type: 'object',
      title: 'Forward Watch Configuration',
      properties: {
        camera_ip: {
          type: 'string',
          title: 'Camera IP Address'
        },
        camera_user: {
          type: 'string',
          title: 'Camera Username',
          default: 'admin'
        },
        camera_pass: {
          type: 'string',
          title: 'Camera Password',
          format: 'password'
        },
        rtsp_url: {
          type: 'string',
          title: 'RTSP URL — auto-filled or enter manually'
        },
        detection_interval: {
          type: 'number',
          title: 'Detection interval in seconds',
          default: 300,
          minimum: 10,
          maximum: 600
        },
        ffmpeg_mode: {
          type: 'string',
          title: 'FFmpeg execution mode',
          enum: ['local', 'container'],
          default: 'local'
        },
        ffmpeg_container_image: {
          type: 'string',
          title: 'FFmpeg container image',
          default: 'lscr.io/linuxserver/ffmpeg'
        },
        alert_cooldown: {
          type: 'number',
          title: 'Seconds before re-alerting same target',
          default: 30
        },
        audio_alarm: {
          type: 'boolean',
          title: 'Enable audio alarm',
          default: false
        },
        confidence_threshold: {
          type: 'number',
          title: 'Minimum detection confidence 0-1',
          default: 0.4,
          minimum: 0,
          maximum: 1
        },
        attitude_correction_enabled: {
          type: 'boolean',
          title: 'Apply navigation.attitude correction to camera calibration',
          description: 'When enabled, roll and pitch from navigation.attitude are used to adjust the calibrated horizon for vessel heel and trim.',
          default: false
        },
        opencpn_enabled: {
          type: 'boolean',
          title: 'Show detections in OpenCPN',
          default: true
        },
        ais_nmea_export_compat: {
          type: 'boolean',
          title: 'Enable NMEA AIS export compatibility for virtual targets',
          description: 'Publishes extra AIS fields for NMEA converter plugins. Do not forward generated AIS messages to public AIS networks such as MarineTraffic or AIS Hub.',
          default: false
        }
      },
      required: ['camera_ip', 'camera_user', 'camera_pass']
    },

    registerWithRouter: function(router) {
      router.get('/', (req, res) => {
        res.redirect('webapp/');
      });

      router.get('/webapp', (req, res) => {
        res.redirect('webapp/');
      });

      router.get('/webapp/', (req, res) => {
        res.sendFile(path.join(PUBLIC_PATH, 'index.html'));
      });

      router.get('/api/latest-frame', (req, res) => {
        const framePath = plugin.latestFramePath;
        if (!framePath || !fs.existsSync(framePath)) {
          res.status(404).json({ error: 'No frame available yet' });
          return;
        }

        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(framePath);
      });

      router.get('/api/latest-state', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const attitude = plugin.options && plugin.options.attitude_correction_enabled
          ? getNavigationAttitude(app)
          : null;
        res.json({
          timestamp: plugin.latestTimestamp || null,
          frameVersion: plugin.latestFrameVersion || null,
          frameUrl: plugin.latestFrameVersion
            ? `/plugins/${plugin.id}/api/latest-frame?v=${encodeURIComponent(plugin.latestFrameVersion)}`
            : null,
          virtualHorizon: createVirtualHorizon(plugin.calibration || loadCalibration(app), attitude),
          detections: plugin.latestDetections || []
        });
      });

      router.get('/api/calibration', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(plugin.calibration || loadCalibration(app));
      });

      router.post('/api/calibration', (req, res) => {
        readJsonRequest(req).then((body) => {
          plugin.calibration = saveCalibration(
            app,
            normalizeCalibration(body, plugin.calibration || loadCalibration(app))
          );
          res.setHeader('Cache-Control', 'no-store');
          res.json(plugin.calibration);
        }).catch((err) => {
          res.status(400).json({ error: err.message });
        });
      });
    },

    start: function(options) {
      options = options || {};
      this.startAsync(options).catch((err) => {
        app.debug('Forward Watch startup failed: ' + err.message);
        if (app.setPluginError) app.setPluginError('Startup failed: ' + err.message);
      });
    },

    startAsync: async function(options) {
      app.debug('Starting Forward Watch plugin');

      this.discovery = new CameraDiscovery(app);
      this.grabber = options.ffmpeg_mode === 'container'
        ? new ContainerRtspGrabber(app, options)
        : new RtspGrabber(app);
      this.detector = new Detector(app, MODEL_PATH);
      this.gpsCalc = new GpsCalculator(app);
      this.skOutput = new SignalkOutput(app, options);
      this.ocpnOutput = new OpenCPNOutput(app, options);
      this.latestFramePath = null;
      this.latestFrameVersion = null;
      this.latestTimestamp = null;
      this.latestDetections = [];
      this.calibration = loadCalibration(app);
      this.options = options;

      // Load ONNX model
      await this.detector.init();
      app.debug('ONNX model loaded');

      // Resolve RTSP URL
      let rtspUrl = options.rtsp_url;
      if (!rtspUrl) {
        app.debug('No RTSP URL configured — running ONVIF discovery');
        const cameras = await this.discovery.scan();
        if (cameras.length > 0) {
          rtspUrl = cameras[0].rtsp_url;
          app.debug(`Discovered camera: ${redactRtspUrl(rtspUrl)}`);
        } else {
          rtspUrl = await this.discovery.buildRtspUrl(options.camera_ip, options.camera_user, options.camera_pass);
          app.debug(`Using fallback RTSP URL: ${redactRtspUrl(rtspUrl)}`);
        }
      }
      rtspUrl = addRtspCredentials(rtspUrl, options.camera_user, options.camera_pass);

      this.rtspUrl = rtspUrl;
      if (this.grabber.start) {
        await this.grabber.start(this.rtspUrl);
      }

      app.debug(`Starting detection loop every ${options.detection_interval}s`);
      if (app.setPluginStatus) {
        const mode = options.ffmpeg_mode === 'container' ? 'container FFmpeg' : 'local FFmpeg';
        app.setPluginStatus(`Running with ${mode}`);
      }

      this.running = false;
      const detectOnce = async () => {
        if (this.running) return; // skip if previous inference still in progress
        this.running = true;
        try {
          const framePath = await this.grabber.grabFrame(this.rtspUrl);
          if (!framePath) return;

          const detections = await this.detector.detect(framePath, options.confidence_threshold || 0.4) || [];

          // Get boat position from Signal K
          const boatLat = app.getSelfPath('navigation.position.value.latitude') || null;
          const boatLon = app.getSelfPath('navigation.position.value.longitude') || null;
          const headingTrue = app.getSelfPath('navigation.headingTrue.value');
          const boatHeading = typeof headingTrue === 'number' ? radiansToDegrees(headingTrue) : 0;
          const attitude = options.attitude_correction_enabled ? getNavigationAttitude(app) : null;

          // Enrich detections with GPS position
          const enriched = detections.map(d => {
            const gps = this.gpsCalc.calculate(d, boatLat, boatLon, boatHeading, this.calibration, attitude);
            return Object.assign({}, d, gps ? {
              position: { latitude: gps.lat, longitude: gps.lon },
              distance: gps.distance_m,
              bearing: gps.bearing_deg,
              quadrant: d.cx < 0.5 ? 'port' : 'starboard'
            } : {});
          });
          const withPosition = enriched.filter(d =>
            d.position &&
            typeof d.position.latitude === 'number' &&
            typeof d.position.longitude === 'number'
          );
          const targetByDetection = new Map(
            assignTargetSlots(withPosition).map(target => [target.detection, target])
          );
          const visibleDetections = enriched.map(d => {
            const target = targetByDetection.get(d);
            const aisStaticData = d.position ? getAisStaticData(d, this.calibration) : null;
            return Object.assign({}, d, target ? {
              ais: {
                context: target.context,
                label: target.label,
                mmsi: target.mmsi,
                length: aisStaticData ? aisStaticData.length : null,
                beam: aisStaticData ? aisStaticData.beam : null
              }
            } : {});
          });

          this.latestFramePath = framePath;
          this.latestFrameVersion = getFrameVersion(framePath);
          this.latestTimestamp = new Date().toISOString();
          this.latestDetections = visibleDetections;

          this.skOutput.sendDetections(enriched);
          if (options.opencpn_enabled !== false) this.ocpnOutput.sendDetections(enriched, this.calibration);
        } catch (err) {
          app.debug('Detection loop error: ' + err.message);
        } finally {
          this.running = false;
        }
      };

      this.interval = setInterval(detectOnce, (options.detection_interval || 300) * 1000);
      detectOnce();
    },

    stop: function() {
      app.debug('Stopping Forward Watch plugin');
      if (this.interval) clearInterval(this.interval);
      if (this.ocpnOutput) this.ocpnOutput.stop();
      if (this.grabber) this.grabber.stop();
      if (this.detector) this.detector.terminate();
    }
  };

  return plugin;
};

function addRtspCredentials(rtspUrl, user, pass) {
  if (!rtspUrl || !user || !pass) return rtspUrl;

  try {
    const parsed = new URL(rtspUrl);
    if (parsed.protocol !== 'rtsp:' && parsed.protocol !== 'rtsps:') return rtspUrl;
    if (parsed.username || parsed.password) return rtspUrl;

    parsed.username = user;
    parsed.password = pass;
    return parsed.toString();
  } catch (err) {
    return rtspUrl;
  }
}

function redactRtspUrl(rtspUrl) {
  if (!rtspUrl) return rtspUrl;

  try {
    const parsed = new URL(rtspUrl);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch (err) {
    return rtspUrl;
  }
}

function radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

function getNavigationAttitude(app) {
  const attitude = app.getSelfPath('navigation.attitude.value');
  const roll = attitude && typeof attitude === 'object'
    ? attitude.roll
    : app.getSelfPath('navigation.attitude.value.roll');
  const pitch = attitude && typeof attitude === 'object'
    ? attitude.pitch
    : app.getSelfPath('navigation.attitude.value.pitch');

  return {
    roll: typeof roll === 'number' ? roll : 0,
    pitch: typeof pitch === 'number' ? pitch : 0
  };
}

function createVirtualHorizon(calibrationInput, attitude) {
  const calibration = normalizeCalibration(calibrationInput, DEFAULT_CALIBRATION);
  const pitchOffset = attitude ? radiansToDegrees(attitude.pitch || 0) / calibration.camera_vertical_fov_deg : 0;
  return {
    centerX: calibration.camera_center_x,
    horizonY: Math.max(0, Math.min(1, calibration.camera_horizon_y + pitchOffset)),
    rollDeg: calibration.camera_roll_deg + (attitude ? radiansToDegrees(attitude.roll || 0) : 0),
    curve: calibration.camera_horizon_curve
  };
}

function getFrameVersion(framePath) {
  try {
    return String(Math.round(fs.statSync(framePath).mtimeMs));
  } catch (err) {
    return String(Date.now());
  }
}

function loadCalibration(app) {
  const calibrationPath = getCalibrationPath(app);

  try {
    if (fs.existsSync(calibrationPath)) {
      return normalizeCalibration(JSON.parse(fs.readFileSync(calibrationPath, 'utf8')), DEFAULT_CALIBRATION);
    }
  } catch (err) {
    app.debug(`Failed to load Forward Watch calibration: ${err.message}`);
  }

  return normalizeCalibration(DEFAULT_CALIBRATION);
}

function saveCalibration(app, calibration) {
  const normalized = normalizeCalibration(calibration);
  const calibrationPath = getCalibrationPath(app);
  fs.mkdirSync(path.dirname(calibrationPath), { recursive: true });
  fs.writeFileSync(calibrationPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function getCalibrationPath(app) {
  return path.join(app.getDataDirPath(), CALIBRATION_FILE);
}

function readJsonRequest(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
