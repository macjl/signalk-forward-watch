const AIS_STATIC_DATA = {
  ship:   { typeId: 70, length: 80, beamRatio: 0.15, maxLength: 200 },
  boat:   { typeId: 37, length: 12, beamRatio: 0.33, maxLength: 30 },
  debris: { typeId: 99, length: 1, beamRatio: 1, maxLength: 10 },
  buoy:   { typeId: 99, length: 1, beamRatio: 1, maxLength: 10 },
  kayak:  { typeId: 37, length: 4, beamRatio: 0.25, maxLength: 6 },
  log:    { typeId: 99, length: 2, beamRatio: 0.5, maxLength: 12 }
};

const SIDE_VIEW_ASPECT_RATIO = 1.4;

function getAisStaticData(detection) {
  const defaults = AIS_STATIC_DATA[detection.class_name] || AIS_STATIC_DATA.boat;
  const apparentWidth = getApparentWidth(detection);
  const isSideView = getDetectionAspectRatio(detection) >= SIDE_VIEW_ASPECT_RATIO;
  const estimatedLength = apparentWidth === null
    ? defaults.length
    : isSideView
      ? apparentWidth
      : apparentWidth / defaults.beamRatio;

  const length = roundMetres(clamp(estimatedLength, 0, defaults.maxLength));
  const beam = roundMetres(clamp(length * defaults.beamRatio, 0, length));

  return {
    typeId: defaults.typeId,
    length,
    beam
  };
}

function getApparentWidth(detection) {
  const width = detection.dimensions && detection.dimensions.width;
  if (typeof width !== 'number') return null;
  const defaults = AIS_STATIC_DATA[detection.class_name] || AIS_STATIC_DATA.boat;
  if (!Number.isFinite(width) || width <= 0) return null;
  return clamp(width, 0, defaults.maxLength);
}

function getDetectionAspectRatio(detection) {
  const width = detection.dimensions && detection.dimensions.width;
  const height = detection.dimensions && detection.dimensions.height;
  if (typeof width === 'number' && typeof height === 'number' && height > 0) {
    return width / height;
  }

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
