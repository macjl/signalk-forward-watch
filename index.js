const path = require('path');
const fs = require('fs');
const CameraDiscovery = require('./plugin/camera-discovery');
const RtspGrabber = require('./plugin/rtsp-grabber');
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

    start: async function(options) {
      options = options || {};
      app.debug('Starting Forward Watch plugin');

      this.discovery = new CameraDiscovery(app);
      this.grabber = new RtspGrabber(app);
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
          app.debug(`Discovered camera: ${rtspUrl}`);
        } else {
          rtspUrl = await this.discovery.buildRtspUrl(options.camera_ip, options.camera_user, options.camera_pass);
          app.debug(`Using fallback RTSP URL: ${rtspUrl}`);
        }
      }

      this.rtspUrl = rtspUrl;
      app.debug(`Starting detection loop every ${options.detection_interval}s`);

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
          const boatHeading = app.getSelfPath('navigation.headingTrue.value') || 0;

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
      if (this.grabber) this.grabber.stop();
      if (this.detector) this.detector.terminate();
    }
  };

  return plugin;
};

function getFrameVersion(framePath) {
  try {
    return String(Math.round(fs.statSync(framePath).mtimeMs));
  } catch (err) {
    return String(Date.now());
  }
}
