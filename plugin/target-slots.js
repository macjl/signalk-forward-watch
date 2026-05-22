const CLASS_MMSI_DIGIT = {
  ship: 1,
  boat: 2,
  debris: 3,
  buoy: 4,
  kayak: 5,
  log: 6
};

const CLASS_LABEL = {
  ship: 'FW-SHIP',
  boat: 'FW-BOAT',
  debris: 'FW-DEBRIS',
  buoy: 'FW-BUOY',
  kayak: 'FW-KAYAK',
  log: 'FW-LOG'
};

const MMSI_PREFIX = 800000000;
const MAX_TARGETS_PER_CLASS = 99;

function assignTargetSlots(detections) {
  const byClass = new Map();

  for (const detection of detections) {
    if (!CLASS_MMSI_DIGIT[detection.class_name]) continue;
    const list = byClass.get(detection.class_name) || [];
    list.push(detection);
    byClass.set(detection.class_name, list);
  }

  const targets = [];
  for (const [className, classDetections] of byClass.entries()) {
    classDetections
      .sort((a, b) => a.cx - b.cx)
      .slice(0, MAX_TARGETS_PER_CLASS)
      .forEach((detection, index) => {
        const slot = index + 1;
        const mmsi = MMSI_PREFIX + (index * 10) + CLASS_MMSI_DIGIT[className];
        targets.push({
          detection,
          context: `urn:mrn:imo:mmsi:${mmsi}`,
          label: `${CLASS_LABEL[className]}-${slot}`,
          mmsi
        });
      });
  }

  return targets;
}

module.exports = {
  assignTargetSlots
};
