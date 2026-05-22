const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

class RtspGrabber {
  constructor(app) {
    this.app = app;
    this.currentProcess = null;
    this.frameDir = path.join(app.getDataDirPath(), 'frames');
    this.framePath = path.join(this.frameDir, 'latest.jpg');
  }

  async grabFrame(rtspUrl) {
    return new Promise((resolve) => {
      fs.mkdirSync(this.frameDir, { recursive: true });
      
      // Kill any existing process
      if (this.currentProcess) {
        this.currentProcess.kill();
      }

      const process = ffmpeg(rtspUrl)
        .addOption('-rtsp_transport', 'tcp')
        .addOption('-vframes', '1')
        .addOption('-q:v', '2')
        .on('end', () => {
          this.currentProcess = null;
          if (fs.existsSync(this.framePath)) {
            resolve(this.framePath);
          } else {
            this.app.debug(`Failed to create frame file: ${this.framePath}`);
            resolve(null);
          }
        })
        .on('error', (err) => {
          this.currentProcess = null;
          this.app.debug(`FFmpeg error: ${err.message}`);
          resolve(null);
        })
        .on('start', () => {
          this.currentProcess = process;
        })
        .save(this.framePath);

      // Set timeout
      setTimeout(() => {
        if (this.currentProcess === process) {
          process.kill();
          this.currentProcess = null;
          this.app.debug('FFmpeg timeout');
          resolve(null);
        }
      }, 10000);
    });
  }

  stop() {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }
}

module.exports = RtspGrabber;
