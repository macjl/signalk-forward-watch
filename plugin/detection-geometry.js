'use strict';

const DEFAULT_HORIZONTAL_FOV_DEG = 60;
const DEFAULT_VERTICAL_FOV_DEG = 34;

function getDetectionDimensions(detection, calibration) {
  if (
    typeof detection.distance !== 'number' ||
    typeof detection.w !== 'number' ||
    typeof detection.h !== 'number'
  ) {
    return null;
  }

  const width = getApparentSize(detection.distance, detection.w, getHorizontalFovDeg(calibration));
  const height = getApparentSize(detection.distance, detection.h, getVerticalFovDeg(calibration));
  if (width === null || height === null) return null;

  return {
    width: roundMetres(width),
    height: roundMetres(height)
  };
}

function getApparentSize(distance, imageFraction, fovDeg) {
  const angularSizeRad = Math.max(0, imageFraction) * fovDeg * (Math.PI / 180);
  const size = 2 * distance * Math.tan(angularSizeRad / 2);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function getHorizontalFovDeg(calibration) {
  const value = calibration && Number(calibration.camera_horizontal_fov_deg);
  if (!Number.isFinite(value)) return DEFAULT_HORIZONTAL_FOV_DEG;
  return clamp(value, 10, 180);
}

function getVerticalFovDeg(calibration) {
  const value = calibration && Number(calibration.camera_vertical_fov_deg);
  if (!Number.isFinite(value)) return DEFAULT_VERTICAL_FOV_DEG;
  return clamp(value, 5, 160);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundMetres(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  getDetectionDimensions
};
