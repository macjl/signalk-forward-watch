// Inline spherical earth destination point — replaces geodesy v2 (ESM-only,
// cannot be require()'d from a CommonJS plugin on Node < 22, and returns
// a namespace object rather than the class on Node 22+).
// Formula: Vincenty spherical, identical to geodesy's destinationPoint().
const _R = 6371000;
const { DEFAULT_CALIBRATION, normalizeCalibration } = require('./calibration');

function _destinationPoint(lat, lon, distMetres, bearingDeg) {
  const δ = distMetres / _R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lon * Math.PI / 180;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * sinφ2
  );
  return { lat: φ2 * 180 / Math.PI, lon: ((λ2 * 180 / Math.PI) + 540) % 360 - 180 };
}

class GpsCalculator {
  constructor(app) {
    this.app = app;
  }

  // detection: {cx, cy, w, h, class_name, confidence} (cx/cy/w/h normalized 0-1)
  // boatLat/boatLon: decimal degrees (null if no GPS)
  // boatHeading: degrees true
  calculate(detection, boatLat, boatLon, boatHeading, calibrationInput) {
    if (boatLat === null || boatLon === null) return null;
    const calibration = normalizeCalibration(calibrationInput, DEFAULT_CALIBRATION);

    let distance_m;
    if (calibration.calibrated) {
      const targetY = Math.max(0, Math.min(1, detection.cy + detection.h / 2));
      const horizonY = horizonAtX(detection.cx, calibration);
      const verticalAngleDeg = (targetY - horizonY) * calibration.camera_vertical_fov_deg;
      const verticalAngleRad = Math.max(0.1, verticalAngleDeg) * Math.PI / 180;
      distance_m = Math.max(2, Math.min(500, calibration.camera_height_m / Math.tan(verticalAngleRad)));
    } else {
      const h = Math.max(0.01, Math.min(1.0, detection.h));
      distance_m = Math.max(2, Math.min(500, 5 / h));
    }

    const bearing_deg = (
      boatHeading +
      ((detection.cx - calibration.camera_center_x) * calibration.camera_horizontal_fov_deg) +
      360
    ) % 360;

    const dest = _destinationPoint(boatLat, boatLon, distance_m, bearing_deg);

    return {
      lat:         dest.lat,
      lon:         dest.lon,
      distance_m:  Math.round(distance_m),
      bearing_deg: Math.round(bearing_deg),
      class_name:  detection.class_name,
      confidence:  detection.confidence
    };
  }
}

function horizonAtX(x, calibration) {
  const centerX = Math.max(0, Math.min(1, calibration.camera_center_x));
  const span = Math.max(centerX, 1 - centerX, 0.001);
  const normalizedX = (Math.max(0, Math.min(1, x)) - centerX) / span;
  return Math.max(0, Math.min(1, calibration.camera_horizon_y + (calibration.camera_horizon_curve * normalizedX * normalizedX)));
}

module.exports = GpsCalculator;
