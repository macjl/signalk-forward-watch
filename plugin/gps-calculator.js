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
  calculate(detection, boatLat, boatLon, boatHeading, calibrationInput, attitudeInput) {
    if (boatLat === null || boatLon === null) return null;
    const calibration = normalizeCalibration(calibrationInput, DEFAULT_CALIBRATION);
    const pitchOffset = attitudeInput ? radiansToDegrees(attitudeInput.pitch || 0) / calibration.camera_vertical_fov_deg : 0;
    const rollRad = degreesToRadians(calibration.camera_roll_deg) + (attitudeInput ? attitudeInput.roll || 0 : 0);
    const center = {
      x: calibration.camera_center_x,
      y: Math.max(0, Math.min(1, calibration.camera_horizon_y + pitchOffset))
    };
    const targetBottom = levelPoint({
      x: detection.cx,
      y: Math.max(0, Math.min(1, detection.cy + detection.h / 2))
    }, center, rollRad, calibration.frame_aspect);
    const bearingPoint = levelPoint({
      x: detection.cx,
      y: detection.cy
    }, center, rollRad, calibration.frame_aspect);

    let distance_m;
    if (calibration.calibrated) {
      const targetY = Math.max(0, Math.min(1, targetBottom.y));
      const horizonY = horizonAtX(targetBottom.x, calibration, pitchOffset);
      const verticalAngleDeg = (targetY - horizonY) * calibration.camera_vertical_fov_deg;
      const verticalAngleRad = Math.max(0.1, verticalAngleDeg) * Math.PI / 180;
      distance_m = Math.max(2, Math.min(500, calibration.camera_height_m / Math.tan(verticalAngleRad)));
    } else {
      const h = Math.max(0.01, Math.min(1.0, detection.h));
      distance_m = Math.max(2, Math.min(500, 5 / h));
    }

    const bearing_deg = (
      boatHeading +
      ((bearingPoint.x - calibration.camera_center_x) * calibration.camera_horizontal_fov_deg) +
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

function horizonAtX(x, calibration, pitchOffset) {
  const centerX = Math.max(0, Math.min(1, calibration.camera_center_x));
  const clampedX = Math.max(0, Math.min(1, x));
  const span = Math.max(centerX, 1 - centerX, 0.001);
  const normalizedX = (clampedX - centerX) / span;
  const horizonY = calibration.camera_horizon_y +
    (calibration.camera_horizon_curve * normalizedX * normalizedX) +
    pitchOffset;

  return Math.max(0, Math.min(1, horizonY));
}

function levelPoint(point, center, rollRad, frameAspect) {
  const dx = (point.x - center.x) * frameAspect;
  const dy = point.y - center.y;
  const cos = Math.cos(-rollRad);
  const sin = Math.sin(-rollRad);

  return {
    x: center.x + ((dx * cos) - (dy * sin)) / frameAspect,
    y: center.y + (dx * sin) + (dy * cos)
  };
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

module.exports = GpsCalculator;
