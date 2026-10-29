// src/main/engine/segment.ts
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { createWriteStream, promises as fsp } from "fs";
import { dirname } from "path";

// src/main/engine/probe.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function buildDownloadHeaders(pageUrl, extra) {
  const headers = {
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
  };
  if (pageUrl) headers.Referer = pageUrl;
  if (extra) Object.assign(headers, extra);
  return headers;
}

// src/main/engine/segment.ts
var MAX_RETRIES = 5;
var RETRY_DELAY_MS = 800;
var CONNECT_TIMEOUT_MS = 2e4;
var IDLE_TIMEOUT_MS = 3e4;
var SPEED_WINDOW_MS = 1e3;
var SpeedMeter = class {
  samples = [];
  totalSampled = 0;
  add(bytes) {
    const now = Date.now();
    this.samples.push({ at: now, bytes });
    this.totalSampled += bytes;
    this.prune(now);
  }
  prune(now) {
    const cutoff = now - SPEED_WINDOW_MS * 2;
    while (this.samples.length > 1 && this.samples[0].at < cutoff) {
      this.totalSampled -= this.samples.shift().bytes;
    }
  }
  get speed() {
    const now = Date.now();
    this.prune(now);
    if (this.samples.length === 0) return 0;
    const first = this.samples[0];
    const span = Math.max(now - first.at, 200);
    return Math.round(this.totalSampled / span * 1e3);
  }
};
var SegmentedJob = class {
  opts;
  events;
  fd = null;
  segments = [];
  abort = new AbortController();
  meter = new SpeedMeter();
  downloaded = 0;
  activeRequests = 0;
  finished = false;
  errored = false;
  paused = false;
  lastActivity = Date.now();
  speedLimiter = null;
  progressTimer = null;
  throttleTimer = null;
  constructor(opts, events) {
    this.opts = opts;
    this.events = events;
    if (opts.speedLimitBps && opts.speedLimitBps > 0) {
      this.speedLimiter = { last: Date.now(), tokens: 0 };
    }
  }
  get isFinished() {
    return this.finished;
  }
  get bytesDownloaded() {
    return this.downloaded;
  }
  /**
   * Kuyruktan gelen mevcut segment ilerlemesiyle devam eder
   * (resume için); yoksa sıfırdan planlar.
   */
  async start(existing) {
    const { savePath, totalBytes, supportsRange, segments } = this.opts;
    try {
      await fsp.mkdir(dirname(savePath), { recursive: true });
    } catch {
    }
    if (supportsRange && totalBytes > 0 && segments > 1) {
      this.segments = existing && existing.length ? existing : this.planSegments(totalBytes, segments);
      this.fd = await fsp.open(savePath, "r+").catch(async () => {
        const fh = await fsp.open(savePath, "w+");
        return fh;
      });
      await this.fd.truncate(totalBytes).catch(() => void 0);
    } else {
      this.segments = [
        {
          index: 0,
          start: existing?.[0]?.received ?? 0,
          end: totalBytes > 0 ? totalBytes - 1 : Number.MAX_SAFE_INTEGER,
          received: existing?.[0]?.received ?? 0
        }
      ];
      this.fd = await fsp.open(savePath, existing?.[0]?.received ? "r+" : "w+");
      if (existing?.[0]?.received) {
        await this.fd.truncate(existing[0].received).catch(() => void 0);
      }
    }
    this.downloaded = this.segments.reduce((a, s) => a + s.received, 0);
    this.lastActivity = Date.now();
    this.progressTimer = setInterval(() => {
      this.maybeDone();
      this.emitProgress();
    }, 400);
    if (this.speedLimiter) {
      this.throttleTimer = setInterval(() => this.refillTokens(), 200);
    }
    for (const seg of this.segments) {
      if (seg.received + seg.start > seg.end && seg.end !== Number.MAX_SAFE_INTEGER) continue;
      this.runSegment(seg);
    }
    this.maybeDone();
    const watchdog = setInterval(() => {
      if (this.finished) {
        clearInterval(watchdog);
        return;
      }
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS && this.activeRequests > 0) {
        this.killActive(new Error("ba\u011Flant\u0131 zaman a\u015F\u0131m\u0131na u\u011Frad\u0131 (bo\u015Fta)"));
      }
    }, 5e3);
    this.abort.signal.addEventListener("abort", () => clearInterval(watchdog));
  }
  planSegments(totalBytes, count) {
    const n = Math.max(1, Math.min(count, Math.floor(totalBytes / (256 * 1024)) || 1));
    const size = Math.floor(totalBytes / n);
    const segs = [];
    for (let i = 0; i < n; i++) {
      const start = i * size;
      const end = i === n - 1 ? totalBytes - 1 : start + size - 1;
      segs.push({ index: i, start, end, received: 0 });
    }
    return segs;
  }
  /** Duraklatma anındaki segment durumunu döndür (kaydetmek için) */
  snapshot() {
    return this.segments.map((s) => ({ ...s }));
  }
  refillTokens() {
    if (!this.speedLimiter) return;
    const limit = this.opts.speedLimitBps;
    const now = Date.now();
    const elapsed = (now - this.speedLimiter.last) / 1e3;
    this.speedLimiter.last = now;
    this.speedLimiter.tokens = Math.min(limit, this.speedLimiter.tokens + limit * elapsed);
  }
  /** Hız sınırı: token yoksa beklet, varsa harca */
  async consumeTokens(bytes) {
    if (!this.speedLimiter) return;
    const limit = this.opts.speedLimitBps;
    const chunk = Math.min(bytes, Math.max(Math.floor(limit / 4), 16 * 1024));
    while (this.speedLimiter.tokens < chunk && !this.abort.signal.aborted) {
      const need = chunk - this.speedLimiter.tokens;
      const waitMs = Math.ceil(need / limit * 1e3);
      await sleep(Math.min(Math.max(waitMs, 50), 500));
      this.refillTokens();
      this.speedLimiter.tokens = Math.min(limit, this.speedLimiter.tokens);
      if (this.speedLimiter.tokens >= chunk) break;
    }
    if (!this.abort.signal.aborted && this.speedLimiter) {
      this.speedLimiter.tokens -= chunk;
    }
  }
  emitProgress() {
    if (this.finished) return;
    this.events.onProgress({
      downloadedBytes: this.downloaded,
      totalBytes: this.opts.totalBytes,
      speed: this.meter.speed,
      connections: this.activeRequests
    });
  }
  async runSegment(seg, attempt = 0) {
    if (this.abort.signal.aborted || this.finished || this.errored) return;
    const complete = seg.end !== Number.MAX_SAFE_INTEGER && seg.start + seg.received > seg.end;
    if (complete) {
      this.maybeDone();
      return;
    }
    this.activeRequests++;
    try {
      await this.fetchSegment(seg);
    } catch (e) {
      if (this.abort.signal.aborted || this.finished) return;
      if (e?.code === "ABORT_ERR" || e?.name === "AbortError") return;
      if (attempt < MAX_RETRIES && !this.errored) {
        await sleep(RETRY_DELAY_MS * Math.pow(1.6, attempt));
        return this.runSegment(seg, attempt + 1);
      }
      this.fail(e instanceof Error ? e : new Error(String(e)));
      return;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
    this.maybeDone();
  }
  fetchSegment(seg) {
    return new Promise((resolve, reject) => {
      const { url, pageUrl, headers: extraHeaders, totalBytes } = this.opts;
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      const headers = buildDownloadHeaders(pageUrl, extraHeaders);
      const rangeStart = seg.start + seg.received;
      if (this.opts.supportsRange && totalBytes > 0) {
        headers.Range = `bytes=${rangeStart}-${seg.end}`;
      } else if (seg.received > 0) {
        headers.Range = `bytes=${rangeStart}-`;
      }
      let settled = false;
      let doneRequested = false;
      let requestedErr;
      let chain = Promise.resolve();
      let segFailed = false;
      let timeoutHandle;
      const settleNow = (err) => {
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const maybeSettle = () => {
        if (settled || !doneRequested) return;
        settled = true;
        settleNow(requestedErr);
      };
      const done = (err) => {
        if (err && !settled) requestedErr = err;
        if (doneRequested || settled) return;
        doneRequested = true;
        chain.then(maybeSettle, maybeSettle);
      };
      const req = (isHttps ? httpsRequest : httpRequest)(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: "GET",
          headers,
          signal: this.abort.signal
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            this.opts.url = next;
            cleanup();
            this.fetchSegment(seg).then(() => done(), (e) => done(e));
            return;
          }
          if (res.statusCode === 416) {
            res.resume();
            seg.received = Math.max(seg.received, seg.end - seg.start + 1);
            done();
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            const map = {
              403: "eri\u015Fim reddedildi (403)",
              404: "dosya bulunamad\u0131 (404)",
              410: "dosya art\u0131k yok (410)"
            };
            done(new Error(map[res.statusCode] || `sunucu hatas\u0131 (${res.statusCode})`));
            return;
          }
          res.on("data", (chunk) => {
            if (this.abort.signal.aborted) {
              res.destroy();
              return;
            }
            this.lastActivity = Date.now();
            res.pause();
            chain = chain.then(async () => {
              try {
                if (this.abort.signal.aborted || segFailed) return;
                const pos = seg.start + seg.received;
                const remain = seg.end !== Number.MAX_SAFE_INTEGER ? seg.end - pos + 1 : Infinity;
                const buf = chunk.length > remain ? chunk.subarray(0, Math.max(0, remain)) : chunk;
                if (buf.length === 0) return;
                if (this.speedLimiter) await this.consumeTokens(buf.length);
                if (this.abort.signal.aborted || !this.fd) return;
                await this.fd.write(buf, 0, buf.length, pos);
                seg.received += buf.length;
                this.downloaded += buf.length;
                this.meter.add(buf.length);
                if (seg.end !== Number.MAX_SAFE_INTEGER && seg.start + seg.received > seg.end) {
                  res.destroy();
                  done();
                }
              } catch (e) {
                segFailed = true;
                res.destroy();
                done(e instanceof Error ? e : new Error(String(e)));
              } finally {
                if (!res.destroyed) res.resume();
              }
            });
          });
          res.on("end", () => done());
          res.on("close", () => {
            if (settled || doneRequested) return;
            if (this.abort.signal.aborted) {
              done();
              return;
            }
            if (seg.end !== Number.MAX_SAFE_INTEGER && seg.start + seg.received > seg.end || segFailed) {
              done();
            } else {
              done(new Error("ba\u011Flant\u0131 beklenmedik \u015Fekilde kapand\u0131"));
            }
          });
          res.on("error", (e) => done(e));
        }
      );
      const cleanup = () => {
        req.removeAllListeners();
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      req.on("timeout", () => req.destroy(new Error("ba\u011Flant\u0131 zaman a\u015F\u0131m\u0131")));
      req.on("error", (e) => done(e));
      timeoutHandle = setTimeout(() => {
        if (!settled && this.activeRequests > 0 && Date.now() - this.lastActivity > CONNECT_TIMEOUT_MS) {
          req.destroy(new Error("ba\u011Flant\u0131 zaman a\u015F\u0131m\u0131"));
        }
      }, CONNECT_TIMEOUT_MS);
      req.on("close", () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
      req.end();
    });
  }
  killActive(err) {
    this.fail(err);
  }
  maybeDone() {
    if (this.finished || this.errored) return;
    if (this.activeRequests > 0) return;
    const allDone = this.segments.every(
      (s) => s.end === Number.MAX_SAFE_INTEGER ? false : s.start + s.received > s.end
    );
    if (allDone) {
      this.finish();
    }
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.emitProgress();
    this.events.onDone();
  }
  fail(err) {
    if (this.errored || this.finished) return;
    this.errored = true;
    this.cleanup();
    this.events.onError(err);
  }
  /** Kullanıcı duraklattı: istekleri durdur ve fd'yi kapat */
  pause() {
    this.paused = true;
    const snap = this.snapshot();
    this.abort.abort();
    this.cleanup();
    this.finished = true;
    return snap;
  }
  cancel() {
    this.abort.abort();
    this.cleanup();
    this.finished = true;
  }
  cleanup() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.throttleTimer) {
      clearInterval(this.throttleTimer);
      this.throttleTimer = null;
    }
    setTimeout(async () => {
      try {
        await this.fd?.close();
      } catch {
      }
      this.fd = null;
    }, 150);
  }
};
async function downloadWholeFile(url, savePath, opts = {}) {
  await fsp.mkdir(dirname(savePath), { recursive: true });
  await new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: buildDownloadHeaders(opts.pageUrl),
        signal: opts.signal
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          downloadWholeFile(next, savePath, opts).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`sunucu hatas\u0131 (${res.statusCode})`));
          return;
        }
        const ws = createWriteStream(savePath);
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          opts.onProgress?.(bytes);
        });
        res.pipe(ws);
        ws.on("finish", () => resolve());
        ws.on("error", reject);
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
export {
  SegmentedJob,
  downloadWholeFile
};
