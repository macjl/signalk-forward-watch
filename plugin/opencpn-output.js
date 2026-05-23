// Writes forward watch detections into Signal K as fake vessels
// OpenCPN reads them via its existing Signal K connection and displays them as AIS targets

const { assignTargetSlots } = require('./target-slots');
const { getAisStaticData } = require('./ais-target-data');

const PLUGIN_ID = 'signalk-forward-watch';
const CLEAR_VALUES = [
  { path: 'navigation.position', value: null },
  { path: 'name', value: null },
  { path: 'sensors.ais.class', value: null },
  { path: 'navigation.courseOverGroundTrue', value: null },
  { path: 'navigation.headingTrue', value: null },
  { path: 'navigation.speedOverGround', value: null },
  { path: 'communication.callsignVhf', value: null },
  { path: 'design.aisShipType.id', value: null },
  { path: 'design.length.overall', value: null },
  { path: 'design.beam', value: null }
];

class OpenCPNOutput {
  constructor(app, options) {
    this.app = app;
    this.options = options || {};
    this.activeContexts = new Set();
  }

  sendDetections(detections, calibration) {
    const withPos = detections.filter(d =>
      d.position &&
      typeof d.position.latitude === 'number' &&
      typeof d.position.longitude === 'number'
    );

    const targets = assignTargetSlots(withPos);
    const currentContexts = new Set(targets.map(target => target.context));

    for (const target of targets) {
      const { detection: d, context, label } = target;
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
        const staticData = getAisStaticData(d, calibration);
        const crossingHeading = getCrossingHeading(d);
        values.push(
          {
            path: 'sensors.ais.class',
            value: 'B'
          },
          {
            path: 'navigation.courseOverGroundTrue',
            value: degreesToRadians(crossingHeading)
          },
          {
            path: 'navigation.headingTrue',
            value: degreesToRadians(crossingHeading)
          },
          {
            path: 'navigation.speedOverGround',
            value: 0
          },
          {
            path: 'communication.callsignVhf',
            value: getCallSign(target.mmsi)
          },
          {
            path: 'design.aisShipType.id',
            value: staticData.typeId
          },
          {
            path: 'design.length.overall',
            value: staticData.length
          },
          {
            path: 'design.beam',
            value: staticData.beam
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

function getCallSign(mmsi) {
  return `FW${String(mmsi).slice(-5)}`;
}

function getCrossingHeading(detection) {
  const bearing = typeof detection.bearing === 'number' ? detection.bearing : 0;
  const turn = typeof detection.cx === 'number' && detection.cx > 0.5 ? -90 : 90;
  return (bearing + turn + 360) % 360;
}

function degreesToRadians(degrees) {
  return degrees * Math.PI / 180;
}

module.exports = OpenCPNOutput;
