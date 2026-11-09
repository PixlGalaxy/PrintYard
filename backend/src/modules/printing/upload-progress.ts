/**
 * Progress/ETA estimate for a G-code upload to the printer, from the bytes handed to the socket.
 *
 * The kernel socket buffers swallow the first chunk of the file at once (a few hundred KB over Wi-Fi, several MB on
 * a loopback), so "written" runs ahead of "received". The estimator therefore:
 *  - treats the bytes written within the first 250 ms as that buffer (`burst`);
 *  - measures the steady rate from what was written after it, up to the last time the written count grew (that is
 *    what the printer drains; writes advance in steps once the buffers are full);
 *  - once the rate is known (≥ 2 s and ≥ 5 % of the file after the burst), reports delivered ≈ min(written, rate × elapsed) and ETA = rest / rate;
 *  - never lets the percent go down, keeps it ≤ 99 until the printer has answered (`done` → 100, ETA 0).
 */
export class UploadEstimator {
  private started = -1;
  private burst = -1;
  private burstAt = 0;
  private lastPercent = 0;
  private lastSent = 0;
  private lastChangeAt = 0;

  constructor(private readonly burstWindowMs = 250) {}

  sample(sentBytes: number, totalBytes: number, done: boolean, now: number): { percent: number; etaSec: number | null } {
    if (done) {
      this.lastPercent = 100;
      return { percent: 100, etaSec: 0 };
    }
    if (this.started < 0) this.started = now;
    const elapsedMs = now - this.started;
    if (this.burst < 0 && elapsedMs >= this.burstWindowMs) {
      this.burst = sentBytes;
      this.burstAt = now;
    }
    if (sentBytes !== this.lastSent) {
      this.lastSent = sentBytes;
      this.lastChangeAt = now;
    }
    // Until the drain rate is known, what went past the initial burst may still be buffered: don't count it yet
    let delivered = this.burst >= 0 ? Math.min(sentBytes, Math.max(this.burst, 0)) : sentBytes;
    let etaSec: number | null = null;
    const steadyMs = this.lastChangeAt - this.burstAt;
    // Only trust the rate over a long enough window (writes advance in steps once the buffers are full)
    if (this.burst >= 0 && steadyMs >= 2000 && sentBytes - this.burst >= totalBytes * 0.05) {
      const rate = ((sentBytes - this.burst) / steadyMs) * 1000; // bytes/s the printer drains
      delivered = Math.min(sentBytes, (rate * elapsedMs) / 1000);
      etaSec = Math.max(1, Math.round((totalBytes - delivered) / rate));
    }
    const raw = totalBytes > 0 ? Math.floor((delivered / totalBytes) * 100) : 0;
    this.lastPercent = Math.max(this.lastPercent, Math.min(99, raw));
    return { percent: this.lastPercent, etaSec };
  }
}
