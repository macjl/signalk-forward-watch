const fs = require('fs');
const path = require('path');

const CONTAINER_NAME = 'forward-watch-ffmpeg';
const DATA_MOUNT = '/signalk-data';
const FRAME_FILE = 'latest.jpg';
const PLUGIN_VERSION = require('../package.json').version;

class ContainerRtspGrabber {
  constructor(app, options) {
    this.app = app;
    this.options = options || {};
    this.containers = null;
    this.dataDir = app.getDataDirPath();
    this.frameDir = path.join(this.dataDir, 'frames');
    this.framePath = path.join(this.frameDir, FRAME_FILE);
    this.frameMaxAgeMs = Math.max((this.options.detection_interval || 1) * 3000, 10000);
    this.started = false;
    this.stopped = false;
    this.rtspUrl = null;
    this.restartPromise = null;
  }

  async start(rtspUrl) {
    this.rtspUrl = rtspUrl;
    this.stopped = false;
    fs.mkdirSync(this.frameDir, { recursive: true });

    this.containers = globalThis.__signalk_containerManager;
    if (!this.containers) {
      throw new Error('signalk-container plugin is required for container FFmpeg mode');
    }

    await this.containers.whenReady();
    if (!this.containers.getRuntime()) {
      throw new Error('No Docker/Podman runtime detected by signalk-container');
    }

    await this.startContainer();
    this.started = true;
    this.app.debug(`FFmpeg container writing frames to ${this.framePath}`);
  }

  async startContainer() {
    const mount = await this.resolveFrameMount();
    const { image, tag } = resolveImageAndTag(this.options.ffmpeg_container_image);
    const frameEvery = Math.max(1, this.options.detection_interval || 1);

    await this.containers.ensureRunning(
      CONTAINER_NAME,
      {
        image,
        tag,
        restart: 'unless-stopped',
        resources: {
          cpus: 0.75,
          memory: '256m',
          memorySwap: '256m',
          pidsLimit: 100
        },
        command: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'warning',
          '-rtsp_transport',
          'tcp',
          '-i',
          this.rtspUrl,
          '-an',
          '-vf',
          `fps=1/${frameEvery}`,
          '-q:v',
          '2',
          '-update',
          '1',
          '-y',
          mount.containerFramePath
        ],
        ...mount.config
      },
      {
        pluginId: 'signalk-forward-watch',
        pluginVersion: PLUGIN_VERSION,
        onContainerLog: (line) => this.app.debug(`[ffmpeg-container] ${line}`),
        onContainerLogStartTail: 25
      }
    );
  }

  async resolveFrameMount() {
    const relativeFramePath = path.relative(this.dataDir, this.framePath);
    if (!relativeFramePath || relativeFramePath.startsWith('..') || path.isAbsolute(relativeFramePath)) {
      throw new Error(`Forward Watch frame path is outside the plugin data directory: ${this.framePath}`);
    }

    if (typeof this.containers.resolveHostPath !== 'function') {
      throw new Error('signalk-container does not provide resolveHostPath; please update signalk-container');
    }

    const resolved = await this.containers.resolveHostPath(this.dataDir);
    if (!resolved) {
      throw new Error(
        'signalk-container could not resolve Forward Watch data directory for the FFmpeg container. ' +
          'If Signal K runs in Docker with host networking, set SIGNALK_CONTAINER_ID to the Signal K container name.'
      );
    }

    return {
      config: { volumes: { [DATA_MOUNT]: resolved.source } },
      containerFramePath: path.posix.join(DATA_MOUNT, toPosix(resolved.subPath || ''), toPosix(relativeFramePath))
    };
  }

  async grabFrame() {
    if (!this.started) return null;

    let stat;
    try {
      stat = fs.statSync(this.framePath);
    } catch (err) {
      this.app.debug(`FFmpeg container has not produced a frame yet: ${err.message}`);
      return null;
    }

    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > this.frameMaxAgeMs) {
      this.app.debug(`FFmpeg container frame is stale (${Math.round(ageMs / 1000)}s old)`);
      await this.restartStaleContainer();
      return null;
    }

    return this.framePath;
  }

  async restartStaleContainer() {
    if (this.stopped || !this.containers || !this.rtspUrl) return;

    if (!this.restartPromise) {
      this.restartPromise = (async () => {
        this.app.debug('Restarting FFmpeg container because frame output is stale');
        this.started = false;

        try {
          await this.containers.stop(CONTAINER_NAME);
        } catch (err) {
          this.app.debug(`Failed to stop stale FFmpeg container: ${err.message}`);
        }

        if (this.stopped) return;

        await this.startContainer();
        this.started = true;
        this.app.debug(`FFmpeg container restarted, writing frames to ${this.framePath}`);
      })().finally(() => {
        this.restartPromise = null;
      });
    }

    await this.restartPromise;
  }

  stop() {
    this.stopped = true;
    this.started = false;
    if (!this.containers) return;
    this.containers.stop(CONTAINER_NAME).catch((err) => {
      this.app.debug(`Failed to stop FFmpeg container: ${err.message}`);
    });
  }
}

function toPosix(value) {
  return value.split(path.sep).filter(Boolean).join('/');
}

function resolveImageAndTag(imageValue) {
  let image = imageValue || 'lscr.io/linuxserver/ffmpeg';
  let tag = 'latest';
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');

  if (lastColon > lastSlash) {
    tag = image.slice(lastColon + 1);
    image = image.slice(0, lastColon);
  }

  return { image, tag };
}

module.exports = ContainerRtspGrabber;
