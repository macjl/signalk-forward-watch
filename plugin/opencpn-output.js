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
            value: getCallSign(d.ais.mmsi)
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

function getCrossingHeading(detection) {
  const bearing = typeof detection.bearing === 'number' ? detection.bearing : 0;
  const turn = typeof detection.cx === 'number' && detection.cx > 0.5 ? -90 : 90;
  return (bearing + turn + 360) % 360;
}

function degreesToRadians(degrees) {
  return degrees * Math.PI / 180;
}

module.exports = OpenCPNOutput;
