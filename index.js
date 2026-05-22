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

const MODEL_PATH = path.join(__dirname, 'models', 'forward-watch.onnx');
const PUBLIC_PATH = path.join(__dirname, 'public');

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
        opencpn_enabled: {
          type: 'boolean',
          title: 'Show detections in OpenCPN',
          default: true
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
        res.json({
          timestamp: plugin.latestTimestamp || null,
          frameVersion: plugin.latestFrameVersion || null,
          frameUrl: plugin.latestFrameVersion
            ? `/plugins/${plugin.id}/api/latest-frame?v=${encodeURIComponent(plugin.latestFrameVersion)}`
            : null,
          detections: plugin.latestDetections || []
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
      this.ocpnOutput = new OpenCPNOutput(app);
      this.latestFramePath = null;
      this.latestFrameVersion = null;
      this.latestTimestamp = null;
      this.latestDetections = [];

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

          // Enrich detections with GPS position
          const enriched = detections.map(d => {
            const gps = this.gpsCalc.calculate(d, boatLat, boatLon, boatHeading);
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
            return Object.assign({}, d, target ? {
              ais: {
                context: target.context,
                label: target.label,
                mmsi: target.mmsi
              }
            } : {});
          });

          this.latestFramePath = framePath;
          this.latestFrameVersion = getFrameVersion(framePath);
          this.latestTimestamp = new Date().toISOString();
          this.latestDetections = visibleDetections;

          this.skOutput.sendDetections(enriched);
          if (options.opencpn_enabled !== false) this.ocpnOutput.sendDetections(enriched);
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

function getFrameVersion(framePath) {
  try {
    return String(Math.round(fs.statSync(framePath).mtimeMs));
  } catch (err) {
    return String(Date.now());
  }
}
