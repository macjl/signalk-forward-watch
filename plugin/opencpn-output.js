// Writes forward watch detections into Signal K as fake vessels
// OpenCPN reads them via its existing Signal K connection and displays them as AIS targets

const { assignTargetSlots } = require('./target-slots');

const AIS_STATIC_DATA = {
  ship:   { typeId: 70, typeName: 'Cargo', length: 80, beamRatio: 0.15, minLength: 20, maxLength: 200, approachSpeed: 5 },
  boat:   { typeId: 37, typeName: 'Pleasure Craft', length: 12, beamRatio: 0.33, minLength: 3, maxLength: 30, approachSpeed: 2.5 },
  debris: { typeId: 99, typeName: 'Other Type', length: 1, beamRatio: 1, minLength: 1, maxLength: 10, approachSpeed: 1 },
  buoy:   { typeId: 99, typeName: 'Other Type', length: 1, beamRatio: 1, minLength: 1, maxLength: 10, approachSpeed: 1 },
  kayak:  { typeId: 37, typeName: 'Pleasure Craft', length: 4, beamRatio: 0.25, minLength: 2, maxLength: 6, approachSpeed: 1.5 },
  log:    { typeId: 99, typeName: 'Other Type', length: 2, beamRatio: 0.5, minLength: 1, maxLength: 12, approachSpeed: 1 }
};
const HORIZONTAL_FOV_DEG = 60;

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
  { path: 'design.aisShipType.name', value: null },
  { path: 'design.length.overall', value: null },
  { path: 'design.beam', value: null },
  { path: 'sensors.ais.fromBow', value: null },
  { path: 'sensors.ais.fromCenter', value: null }
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
        const staticData = getAisStaticData(d);
        const approachHeading = getApproachHeading(d);
        values.push(
          {
            path: 'sensors.ais.class',
            value: 'B'
          },
          {
            path: 'navigation.courseOverGroundTrue',
            value: degreesToRadians(approachHeading)
          },
          {
            path: 'navigation.headingTrue',
            value: degreesToRadians(approachHeading)
          },
          {
            path: 'navigation.speedOverGround',
            value: staticData.approachSpeed
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
            path: 'design.aisShipType.name',
            value: staticData.typeName
          },
          {
            path: 'design.length.overall',
            value: staticData.length
          },
          {
            path: 'design.beam',
            value: staticData.beam
          },
          {
            path: 'sensors.ais.fromBow',
            value: Math.max(0, Math.round(staticData.length / 2))
          },
          {
            path: 'sensors.ais.fromCenter',
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

function getAisStaticData(detection) {
  const defaults = AIS_STATIC_DATA[detection.class_name] || AIS_STATIC_DATA.boat;
  let length = defaults.length;

  if (
    typeof detection.distance === 'number' &&
    typeof detection.w === 'number'
  ) {
    const angularWidthRad = Math.max(0, detection.w) * HORIZONTAL_FOV_DEG * (Math.PI / 180);
    const apparentWidth = 2 * detection.distance * Math.tan(angularWidthRad / 2);
    if (Number.isFinite(apparentWidth) && apparentWidth > 0) {
      length = clamp(apparentWidth, defaults.minLength, defaults.maxLength);
    }
  }

  return {
    typeId: defaults.typeId,
    typeName: defaults.typeName,
    length: roundMetres(length),
    beam: roundMetres(clamp(length * defaults.beamRatio, 1, length)),
    approachSpeed: defaults.approachSpeed
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundMetres(value) {
  return Math.max(1, Math.round(value));
}

function getCallSign(mmsi) {
  return `FW${String(mmsi).slice(-5)}`;
}

function getApproachHeading(detection) {
  const bearing = typeof detection.bearing === 'number' ? detection.bearing : 0;
  return (bearing + 180 + 360) % 360;
}

function degreesToRadians(degrees) {
  return degrees * Math.PI / 180;
}

module.exports = OpenCPNOutput;
