// Writes forward watch detections into Signal K as fake vessels
// OpenCPN reads them via its existing Signal K connection and displays them as AIS targets

const { getAisStaticData } = require('./ais-target-data');

const PLUGIN_ID = 'signalk-forward-watch';

class OpenCPNOutput {
  constructor(app, options) {
    this.app = app;
    this.options = options || {};
  }

  sendDetections(detections) {
    const targets = detections.filter(d =>
      d.ais &&
      d.ais.context &&
      d.position &&
      typeof d.position.latitude === 'number' &&
      typeof d.position.longitude === 'number'
    );

    for (const d of targets) {
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
          value: `${d.ais.label} (${Math.round(d.confidence * 100)}%)`
        }
      ];

      if (this.isNmeaExportCompatEnabled()) {
        const staticData = getAisStaticData(d);
        values.push(
          {
            path: 'sensors.ais.class',
            value: 'B'
          },
          {
            path: 'navigation.speedOverGround',
            value: 0
          },
          {
            path: 'communication',
            value: {
              callsignVhf: getCallSign(d.ais.mmsi)
            }
          },
          {
            path: 'design.aisShipType',
            value: {
              id: staticData.typeId,
              name: staticData.typeName
            }
          },
          {
            path: 'design.beam',
            value: staticData.beam
          },
          {
            path: 'design.length',
            value: {
              overall: staticData.length
            }
          },
          {
            path: 'sensors.ais.fromBow',
            value: staticData.fromBow
          },
          {
            path: 'sensors.ais.fromCenter',
            value: staticData.fromCenter
          }
        );
      }

      this.app.handleMessage(PLUGIN_ID, {
        context: `vessels.${d.ais.context}`,
        updates: [{
          values
        }]
      });

      this.app.debug(`OpenCPN: ${d.ais.label} → ${d.ais.context} at ${d.position.latitude.toFixed(4)},${d.position.longitude.toFixed(4)}`);
    }
  }

  stop() {
    // Leave the last published virtual AIS values untouched. Some Signal K
    // converters do not handle null clears for AIS string/numeric fields.
  }

  isNmeaExportCompatEnabled() {
    return this.options.ais_nmea_export_compat === true;
  }
}

function getCallSign(mmsi) {
  return `FW${String(mmsi).slice(-5)}`;
}

module.exports = OpenCPNOutput;
