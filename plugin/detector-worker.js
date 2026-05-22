'use strict';

// This file runs inside a Node.js Worker thread.
// onnxruntime-node is required here so it is isolated in the worker heap,
// not loaded into the Signal K main process when the plugin is registered.

const { parentPort } = require('worker_threads');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const fs = require('fs');

const CLASS_NAMES = ['ship', 'boat', 'debris', 'buoy', 'kayak', 'log'];
const IMG_SIZE = 640;

let session = null;

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    try {
      session = await ort.InferenceSession.create(msg.modelPath);
      parentPort.postMessage({ type: 'ready' });
    } catch (err) {
      parentPort.postMessage({ type: 'error', message: 'model load failed: ' + err.message });
    }

  } else if (msg.type === 'detect') {
    if (!session || !fs.existsSync(msg.imagePath)) {
      parentPort.postMessage({ type: 'detections', detections: [] });
      return;
    }
    try {
      const metadata = await sharp(msg.imagePath).metadata();
      const sourceWidth = metadata.width || IMG_SIZE;
      const sourceHeight = metadata.height || IMG_SIZE;
      const { data } = await sharp(msg.imagePath)
        .resize(IMG_SIZE, IMG_SIZE, {
          fit: 'contain',
          background: { r: 114, g: 114, b: 114 }
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const tensor = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
      for (let i = 0; i < IMG_SIZE * IMG_SIZE; i++) {
        tensor[i]                           = data[i * 3]     / 255.0; // R
        tensor[IMG_SIZE * IMG_SIZE + i]     = data[i * 3 + 1] / 255.0; // G
        tensor[2 * IMG_SIZE * IMG_SIZE + i] = data[i * 3 + 2] / 255.0; // B
      }

      const input = new ort.Tensor('float32', tensor, [1, 3, IMG_SIZE, IMG_SIZE]);
      const outputMap = await session.run({ images: input });
      const outputTensor = outputMap[Object.keys(outputMap)[0]];
      const detections = parseOutput(outputTensor, msg.confidenceThreshold, sourceWidth, sourceHeight);

      parentPort.postMessage({ type: 'detections', detections });
    } catch (err) {
      parentPort.postMessage({ type: 'error', message: 'inference failed: ' + err.message });
    }
  }
});

// YOLOv8 ONNX output shape: [1, 4+num_classes, num_anchors] = [1, 10, 8400]
function parseOutput(tensor, confidenceThreshold, sourceWidth, sourceHeight) {
  const data = tensor.data;
  const numClasses = CLASS_NAMES.length;
  const numAnchors = tensor.dims[2];
  const scale = Math.min(IMG_SIZE / sourceWidth, IMG_SIZE / sourceHeight);
  const resizedWidth = sourceWidth * scale;
  const resizedHeight = sourceHeight * scale;
  const padX = (IMG_SIZE - resizedWidth) / 2;
  const padY = (IMG_SIZE - resizedHeight) / 2;

  let boxes = [];
  for (let i = 0; i < numAnchors; i++) {
    const cx = data[0 * numAnchors + i];
    const cy = data[1 * numAnchors + i];
    const w  = data[2 * numAnchors + i];
    const h  = data[3 * numAnchors + i];

    let bestScore = 0, bestClass = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numAnchors + i];
      if (score > bestScore) { bestScore = score; bestClass = c; }
    }

    if (bestScore >= confidenceThreshold) {
      const mapped = mapBoxToSource(cx, cy, w, h, padX, padY, resizedWidth, resizedHeight);
      if (!mapped) continue;
      boxes.push({
        class_id:   bestClass,
        class_name: CLASS_NAMES[bestClass],
        confidence: bestScore,
        cx: mapped.cx,
        cy: mapped.cy,
        w:  mapped.w,
        h:  mapped.h
      });
    }
  }

  return nms(boxes, 0.45);
}

function mapBoxToSource(cx, cy, w, h, padX, padY, resizedWidth, resizedHeight) {
  const x1 = clamp((cx - w / 2 - padX) / resizedWidth, 0, 1);
  const y1 = clamp((cy - h / 2 - padY) / resizedHeight, 0, 1);
  const x2 = clamp((cx + w / 2 - padX) / resizedWidth, 0, 1);
  const y2 = clamp((cy + h / 2 - padY) / resizedHeight, 0, 1);

  if (x2 <= x1 || y2 <= y1) return null;
  return {
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
    w: x2 - x1,
    h: y2 - y1
  };
}

function nms(boxes, iouThreshold) {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const selected = [];
  while (boxes.length > 0) {
    const best = boxes.shift();
    selected.push(best);
    boxes = boxes.filter(b => iou(best, b) <= iouThreshold);
  }
  return selected;
}

function iou(a, b) {
  const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2;
  const ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2;
  const bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  if (ix1 >= ix2 || iy1 >= iy2) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  return inter / ((a.w * a.h) + (b.w * b.h) - inter);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
