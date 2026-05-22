// Writes forward watch detections into Signal K as fake vessels
// OpenCPN reads them via its existing Signal K connection and displays them as AIS targets

const { assignTargetSlots } = require('./target-slots');

const PLUGIN_ID = 'signalk-forward-watch';
const CLEAR_VALUES = [
  { path: 'navigation.position', value: null },
  { path: 'name', value: null },
  { path: 'mmsi', value: null },
  { path: 'sensors.ais.class', value: null },
  { path: 'navigation.courseOverGroundTrue', value: null },
  { path: 'navigation.speedOverGround', value: null }
];

class OpenCPNOutput {
  constructor(app, options) {
    this.app = app;
    this.options = options || {};
    this.activeContexts = new Set();
  }

  sendDetections(detections) {
    const withPos = detections.filter(d =>
      d.position &&
      typeof d.position.latitude === 'number' &&
      typeof d.position.longitude === 'number'
    );

    const targets = assignTargetSlots(withPos);
    const currentContexts = new Set(targets.map(target => target.context));

    for (const target of targets) {
      const { detection: d, context, label, mmsi } = target;
      const values = [
        {
          path: 'navigation.position',
          value: {
            latitude: d.position.latitude,
            longitude: d.position.longitude
          }
        },
        {
          path: 'name',
          value: `${label} (${Math.round(d.confidence * 100)}%)`
        }
      ];

      if (this.isNmeaExportCompatEnabled()) {
        values.push(
          {
            path: 'mmsi',
            value: mmsi
          },
          {
            path: 'sensors.ais.class',
            value: 'B'
          },
          {
            path: 'navigation.courseOverGroundTrue',
            value: 0
          },
          {
            path: 'navigation.speedOverGround',
            value: 0
          }
        );
      }

      this.app.handleMessage(PLUGIN_ID, {
        context: `vessels.${context}`,
        updates: [{
          values
        }]
      });

      this.app.debug(`OpenCPN: ${label} → ${context} at ${d.position.latitude.toFixed(4)},${d.position.longitude.toFixed(4)}`);
    }

    for (const context of this.activeContexts) {
      if (!currentContexts.has(context)) this.clearTarget(context);
    }

    this.activeContexts = currentContexts;
  }

  stop() {
    for (const context of this.activeContexts) {
      this.clearTarget(context);
    }
    this.activeContexts.clear();
  }

  clearTarget(context) {
    this.app.handleMessage(PLUGIN_ID, {
      context: `vessels.${context}`,
      updates: [{
        values: CLEAR_VALUES
      }]
    });

    this.app.debug(`OpenCPN: cleared ${context}`);
  }

  isNmeaExportCompatEnabled() {
    return this.options.ais_nmea_export_compat === true;
  }
}

module.exports = OpenCPNOutput;
