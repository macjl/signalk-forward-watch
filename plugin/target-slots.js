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
const MATCH_THRESHOLD = 0.35;

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

class TargetTracker {
  constructor() {
    this.tracksByClass = new Map();
  }

  assign(detections) {
    const byClass = new Map();

    for (const tracks of this.tracksByClass.values()) {
      for (const track of tracks) {
        track.missed += 1;
      }
    }

    for (const detection of detections) {
      if (!CLASS_MMSI_DIGIT[detection.class_name]) continue;
      const list = byClass.get(detection.class_name) || [];
      list.push(detection);
      byClass.set(detection.class_name, list);
    }

    const targets = [];
    for (const [className, classDetections] of byClass.entries()) {
      const tracks = this.getTracks(className);
      const matchedTracks = new Set();

      for (const detection of classDetections.slice(0, MAX_TARGETS_PER_CLASS)) {
        let bestTrack = null;
        let bestScore = Infinity;

        for (const track of tracks) {
          if (matchedTracks.has(track)) continue;
          const score = getMatchScore(track.detection, detection);
          if (score < bestScore) {
            bestScore = score;
            bestTrack = track;
          }
        }

        const track = bestTrack && bestScore <= MATCH_THRESHOLD
          ? bestTrack
          : this.createTrack(className, tracks, matchedTracks);

        track.detection = detection;
        track.missed = 0;
        matchedTracks.add(track);
        targets.push(toTarget(track, detection));
      }
    }

    return targets;
  }

  getTracks(className) {
    const tracks = this.tracksByClass.get(className) || [];
    this.tracksByClass.set(className, tracks);
    return tracks;
  }

  createTrack(className, tracks, matchedTracks) {
    let slot = 1;
    const usedSlots = new Set(tracks.map(track => track.slot));
    while (usedSlots.has(slot) && slot < MAX_TARGETS_PER_CLASS) slot += 1;

    if (usedSlots.has(slot)) {
      const reusable = tracks
        .filter(track => !matchedTracks.has(track))
        .sort((a, b) => b.missed - a.missed)[0];
      if (reusable) return reusable;
    }

    const track = createTrack(className, slot);
    tracks.push(track);
    return track;
  }
}

function createTrack(className, slot) {
  const mmsi = MMSI_PREFIX + ((slot - 1) * 10) + CLASS_MMSI_DIGIT[className];

  return {
    slot,
    mmsi,
    label: `${CLASS_LABEL[className]}-${slot}`,
    context: `urn:mrn:imo:mmsi:${mmsi}`,
    detection: null,
    missed: 0
  };
}

function toTarget(track, detection) {
  return {
    detection,
    context: track.context,
    label: track.label,
    mmsi: track.mmsi
  };
}

function getMatchScore(previous, current) {
  if (!previous) return Infinity;

  const dx = getNumber(current.cx) - getNumber(previous.cx);
  const dy = getNumber(current.cy) - getNumber(previous.cy);
  const imageScore = Math.sqrt((dx * dx) + (dy * dy));
  const distanceScore = getRelativeDelta(previous.distance, current.distance, 50) * 0.15;
  const bearingScore = getBearingDelta(previous.bearing, current.bearing) / 180 * 0.15;

  return imageScore + distanceScore + bearingScore;
}

function getNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getRelativeDelta(a, b, fallback) {
  if (typeof a !== 'number' || typeof b !== 'number') return 0;
  const divisor = Math.max(Math.abs(a), Math.abs(b), fallback);
  return Math.min(1, Math.abs(a - b) / divisor);
}

function getBearingDelta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return 0;
  const delta = Math.abs((a - b + 540) % 360 - 180);
  return Number.isFinite(delta) ? delta : 0;
}

module.exports = {
  assignTargetSlots,
  TargetTracker
};
