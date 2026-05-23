'use strict';

const DEFAULT_CALIBRATION = {
  calibrated: false,
  camera_height_m: 2,
  camera_horizontal_fov_deg: 60,
  camera_vertical_fov_auto: true,
  camera_vertical_fov_deg: 34,
  camera_center_x: 0.5,
  camera_horizon_y: 0.5,
  camera_horizon_curve: 0,
  frame_aspect: 16 / 9
};

function normalizeCalibration(input, fallback) {
  const base = Object.assign({}, DEFAULT_CALIBRATION, fallback || {}, input || {});

  const calibration = {
    calibrated: base.calibrated === true,
    camera_height_m: clampNumber(base.camera_height_m, 0.1, 20, DEFAULT_CALIBRATION.camera_height_m),
    camera_horizontal_fov_deg: clampNumber(base.camera_horizontal_fov_deg, 10, 180, DEFAULT_CALIBRATION.camera_horizontal_fov_deg),
    camera_vertical_fov_auto: base.camera_vertical_fov_auto !== false,
    camera_vertical_fov_deg: clampNumber(base.camera_vertical_fov_deg, 5, 160, DEFAULT_CALIBRATION.camera_vertical_fov_deg),
    camera_center_x: clampNumber(base.camera_center_x, 0, 1, DEFAULT_CALIBRATION.camera_center_x),
    camera_horizon_y: clampNumber(base.camera_horizon_y, 0, 1, DEFAULT_CALIBRATION.camera_horizon_y),
    camera_horizon_curve: clampNumber(base.camera_horizon_curve, -0.5, 0.5, DEFAULT_CALIBRATION.camera_horizon_curve),
    frame_aspect: clampNumber(base.frame_aspect, 0.2, 5, DEFAULT_CALIBRATION.frame_aspect)
  };

  if (calibration.camera_vertical_fov_auto) {
    calibration.camera_vertical_fov_deg = calculateVerticalFov(
      calibration.camera_horizontal_fov_deg,
      calibration.frame_aspect
    );
  }

  return calibration;
}

function calculateVerticalFov(horizontalFovDeg, frameAspect) {
  const horizontalFovRad = horizontalFovDeg * Math.PI / 180;
  const verticalFovRad = 2 * Math.atan(Math.tan(horizontalFovRad / 2) / frameAspect);
  return Math.round((verticalFovRad * 180 / Math.PI) * 10) / 10;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

module.exports = {
  DEFAULT_CALIBRATION,
  normalizeCalibration,
  calculateVerticalFov
};
