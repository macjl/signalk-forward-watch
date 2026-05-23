const AIS_STATIC_DATA = {
  ship:   { typeId: 70, length: 80, beamRatio: 0.15, minLength: 20, maxLength: 200 },
  boat:   { typeId: 37, length: 12, beamRatio: 0.33, minLength: 3, maxLength: 30 },
  debris: { typeId: 99, length: 1, beamRatio: 1, minLength: 1, maxLength: 10 },
  buoy:   { typeId: 99, length: 1, beamRatio: 1, minLength: 1, maxLength: 10 },
  kayak:  { typeId: 37, length: 4, beamRatio: 0.25, minLength: 2, maxLength: 6 },
  log:    { typeId: 99, length: 2, beamRatio: 0.5, minLength: 1, maxLength: 12 }
};

const DEFAULT_HORIZONTAL_FOV_DEG = 60;
const SIDE_VIEW_ASPECT_RATIO = 1.4;

function getAisStaticData(detection, calibration) {
  const defaults = AIS_STATIC_DATA[detection.class_name] || AIS_STATIC_DATA.boat;
  const apparentWidth = getApparentWidth(detection, calibration);
  const isSideView = getDetectionAspectRatio(detection) >= SIDE_VIEW_ASPECT_RATIO;
  const estimatedLength = apparentWidth === null
    ? defaults.length
    : isSideView
      ? apparentWidth
      : apparentWidth / defaults.beamRatio;

  const length = roundMetres(clamp(estimatedLength, defaults.minLength, defaults.maxLength));
  const beam = roundMetres(clamp(length * defaults.beamRatio, Math.min(2, length), length));

  return {
    typeId: defaults.typeId,
    length,
    beam
  };
}

function getApparentWidth(detection, calibration) {
  if (
    typeof detection.distance !== 'number' ||
    typeof detection.w !== 'number'
  ) {
    return null;
  }

  const defaults = AIS_STATIC_DATA[detection.class_name] || AIS_STATIC_DATA.boat;
  const horizontalFovDeg = getHorizontalFovDeg(calibration);
  const angularWidthRad = Math.max(0, detection.w) * horizontalFovDeg * (Math.PI / 180);
  const apparentWidth = 2 * detection.distance * Math.tan(angularWidthRad / 2);
  if (!Number.isFinite(apparentWidth) || apparentWidth <= 0) return null;
  return clamp(apparentWidth, defaults.minLength * defaults.beamRatio, defaults.maxLength);
}

function getHorizontalFovDeg(calibration) {
  const value = calibration && Number(calibration.camera_horizontal_fov_deg);
  if (!Number.isFinite(value)) return DEFAULT_HORIZONTAL_FOV_DEG;
  return clamp(value, 10, 180);
}

function getDetectionAspectRatio(detection) {
  if (
    typeof detection.w !== 'number' ||
    typeof detection.h !== 'number' ||
    detection.h <= 0
  ) {
    return SIDE_VIEW_ASPECT_RATIO;
  }

  return detection.w / detection.h;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundMetres(value) {
  return Math.max(1, Math.round(value));
}

module.exports = {
  getAisStaticData
};
