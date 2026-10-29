// src/main/engine/manager.ts
import { EventEmitter } from "events";
import { existsSync, statSync, unlinkSync } from "fs";
import { basename, dirname as dirname2, extname, join as join2 } from "path";

// src/main/engine/segment.ts
import { request as httpsRequest2 } from "https";
import { request as httpRequest2 } from "http";
import { createWriteStream, promises as fsp } from "fs";
import { dirname } from "path";

// src/main/engine/probe.ts
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function doRequest(urlStr, method, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === "https:";
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          doRequest(next, method, headers, timeoutMs).then(resolve, reject);
          return;
        }
        let truncated = false;
        res.on("data", () => {
          truncated = true;
          res.destroy();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, truncated });
        });
        res.on("close", () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, truncated });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}
function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  if (plain) return plain[1].trim();
  return null;
}
function filenameFromUrl(urlStr) {
  try {
    const p = new URL(urlStr);
    const base = p.pathname.split("/").filter(Boolean).pop();
    if (base) {
      const decoded = decodeURIComponent(base);
      if (decoded && decoded.includes(".")) return sanitizeFilename(decoded);
    }
  } catch {
  }
  return "download";
}
function sanitizeFilename(name) {
  let n = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  n = n.replace(/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i, "_$2");
  n = n.replace(/[. ]+$/, "");
  if (!n) n = "download";
  if (n.length > 200) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : "";
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}
async function probeUrl(urlStr, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15e3;
  const base = {
    ok: false,
    url: urlStr,
    name: filenameFromUrl(urlStr),
    sizeBytes: null,
    supportsRange: false,
    contentType: null,
    host: ""
  };
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ...base, error: `desteklenmeyen protokol: ${parsed.protocol}` };
    }
    base.host = parsed.hostname;
  } catch {
    return { ...base, error: "ge\xE7ersiz URL" };
  }
  const headers = {
    "User-Agent": UA,
    Accept: "*/*"
  };
  if (opts.pageUrl) {
    headers.Referer = opts.pageUrl;
  }
  let method = opts.method ?? "HEAD";
  let res;
  try {
    res = await doRequest(urlStr, method, headers, timeoutMs);
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      method = "GET";
      res = await doRequest(urlStr, method, { ...headers, Range: "bytes=0-0" }, timeoutMs);
    }
  } catch (e) {
    return { ...base, error: e?.message || "ba\u011Flant\u0131 hatas\u0131" };
  }
  if (res.status >= 400) {
    const errText = res.status === 404 ? "dosya bulunamad\u0131 (404)" : `sunucu hatas\u0131 (${res.status})`;
    return { ...base, error: errText };
  }
  const h = res.headers;
  base.contentType = h["content-type"] || null;
  const cdName = filenameFromDisposition(h["content-disposition"]);
  if (cdName) base.name = sanitizeFilename(cdName);
  const len = h["content-length"] ? parseInt(h["content-length"], 10) : NaN;
  if (isFinite(len)) base.sizeBytes = len;
  const cr = h["content-range"];
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) base.sizeBytes = parseInt(m[1], 10);
    base.supportsRange = true;
  }
  if (h["accept-ranges"]?.toLowerCase().includes("bytes")) {
    base.supportsRange = true;
  }
  base.ok = true;
  return base;
}
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
      const req = (isHttps ? httpsRequest2 : httpRequest2)(
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/shared/i18n.ts
var en = {
  // --- Genel ---
  "app.name": "IDMS",
  "app.tagline": "Download Manager",
  "common.ok": "OK",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.save": "Save",
  "common.apply": "Apply",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.browse": "Browse\u2026",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.search": "Search",
  "common.all": "All",
  "common.none": "None",
  "common.yes": "Yes",
  "common.no": "No",
  "common.enabled": "Enabled",
  "common.disabled": "Disabled",
  "common.loading": "Loading\u2026",
  "common.error": "Error",
  "common.retry": "Retry",
  "common.test": "Test",
  "common.reset": "Reset",
  "common.default": "Default",
  "common.unknown": "Unknown",
  "common.unlimited": "Unlimited",
  "common.bytes": "B",
  "common.kb": "KB",
  "common.mb": "MB",
  "common.gb": "GB",
  "common.tb": "TB",
  "common.perSecond": "/s",
  // --- Araç çubuğu ---
  "toolbar.add": "Add URL",
  "toolbar.addHint": "Add a download from URL",
  "toolbar.start": "Start",
  "toolbar.startHint": "Start selected download",
  "toolbar.pause": "Pause",
  "toolbar.pauseHint": "Pause selected download",
  "toolbar.remove": "Remove",
  "toolbar.removeHint": "Remove selected download",
  "toolbar.settings": "Settings",
  "toolbar.settingsHint": "Open settings",
  "toolbar.extension": "Extension",
  "toolbar.extensionHint": "Browser extension status",
  "toolbar.notify": "Notifications",
  "toolbar.notifyHint": "Notification center",
  "toolbar.completed": "Completed",
  "toolbar.completedHint": "Open downloads folder",
  "toolbar.newTorrent": "Torrent",
  // --- Kategoriler ---
  "cat.downloading": "Downloading",
  "cat.completed": "Completed",
  "cat.queued": "Queued",
  "cat.scheduled": "Scheduled",
  "cat.error": "Failed",
  "cat.paused": "Paused",
  "cat.video": "Video",
  "cat.audio": "Audio",
  "cat.archive": "Compressed",
  "cat.program": "Programs",
  "cat.document": "Documents",
  "cat.other": "Other",
  // --- Liste başlıkları ---
  "col.name": "Name",
  "col.size": "Size",
  "col.speed": "Speed",
  "col.eta": "Time left",
  "col.status": "Status",
  "col.progress": "Progress",
  "col.added": "Added",
  "col.category": "Category",
  "col.type": "Type",
  // --- Durumlar ---
  "state.queued": "Queued",
  "state.resolving": "Resolving\u2026",
  "state.confirming": "Waiting for confirmation",
  "state.downloading": "Downloading",
  "state.paused": "Paused",
  "state.completed": "Completed",
  "state.error": "Failed",
  "state.canceled": "Canceled",
  "state.scheduled": "Scheduled",
  // --- Eylemler ---
  "action.resume": "Resume",
  "action.restart": "Restart",
  "action.openFile": "Open file",
  "action.openFolder": "Open folder",
  "action.showInFolder": "Show in folder",
  "action.queue": "Add to queue",
  "action.copyUrl": "Copy URL",
  "action.properties": "Properties",
  "action.clearCompleted": "Clear completed",
  "action.schedule": "Schedule",
  "action.cancelSchedule": "Cancel schedule",
  // --- Satır ayrıntı penceresi ---
  "detail.title": "File details",
  "detail.connections": "Connections",
  "detail.torrentPeers": "Peers",
  "detail.torrentRatio": "Ratio",
  // --- Durum çubuğu ---
  "status.downloads": "downloads",
  "status.active": "Active",
  "status.totalSpeed": "Total speed",
  "status.queued": "In queue",
  "status.done": "Done today",
  "status.extensionConnected": "Extension connected",
  "status.extensionDisconnected": "Extension not connected",
  "status.extensionHelp": "Load the extension in your browser to enable one-click downloads.",
  // --- Yeni indirme penceresi ---
  "add.title": "Add download",
  "add.url": "Address (URL)",
  "add.name": "File name",
  "add.saveTo": "Save to",
  "add.category": "Category",
  "add.startNow": "Start immediately",
  "add.submit": "Download",
  "add.probing": "Checking address\u2026",
  "add.probeFailed": "Address could not be checked. You can still download.",
  "add.sizeUnknown": "Size unknown",
  "add.supportsRange": "Multiple connections supported",
  "add.noRange": "Single connection",
  "add.invalidUrl": "Please enter a valid http(s) URL.",
  "add.clipboardDetected": "A link was detected in the clipboard.",
  "add.paste": "Paste",
  // --- Onay penceresi (indirmeden önce) ---
  "confirm.title": "Download file",
  "confirm.question": "Do you want to download this file?",
  "confirm.download": "Download",
  "confirm.later": "Decide later",
  "confirm.from": "From",
  // --- IDM tarzı indirme pencereleri ---
  "win.add.title": "File Download Information",
  "win.add.url": "Address (URL)",
  "win.add.category": "Category",
  "win.add.saveAs": "Save as",
  "win.add.fileName": "File name",
  "win.add.rememberCategory": 'Remember this path for the "{category}" category',
  "win.add.rememberDir": "Folder to remember",
  "win.add.description": "Description",
  "win.add.preview": "Preview",
  "win.add.later": "Download later",
  "win.add.start": "Start download",
  "win.add.newCategory": "New category",
  "win.add.newCategoryPlaceholder": "Folder name",
  "win.add.addCategory": "Add",
  "win.add.sizeUnknown": "Size unknown",
  "win.add.probing": "Checking address\u2026",
  "win.add.invalidUrl": "Please enter a valid http(s) URL.",
  "win.add.categoryHint": "Files are saved under the selected category folder.",
  "win.progress.title": "Download status",
  "win.progress.tabStatus": "Download status",
  "win.progress.tabLimiter": "Speed limiter",
  "win.progress.tabAfter": "After completion",
  "win.progress.url": "URL",
  "win.progress.status": "Status",
  "win.progress.size": "File size",
  "win.progress.downloaded": "Downloaded",
  "win.progress.speed": "Transfer rate",
  "win.progress.eta": "Time left",
  "win.progress.resume": "Resume capability",
  "win.progress.connecting": "Connecting\u2026",
  "win.progress.receiving": "Receiving data\u2026",
  "win.progress.waiting": "Waiting\u2026",
  "win.progress.done": "Completed",
  "win.progress.paused": "Paused",
  "win.progress.canceled": "Canceled",
  "win.progress.failed": "Failed",
  "win.progress.detailsHide": "Hide details",
  "win.progress.detailsShow": "Show details",
  "win.progress.pause": "Pause",
  "win.progress.resumeBtn": "Resume",
  "win.progress.cancel": "Cancel",
  "win.progress.connHead": "Download progress by connection and connection start positions",
  "win.progress.tableNo": "No.",
  "win.progress.tableReceived": "Received",
  "win.progress.tableInfo": "Info",
  "win.progress.noSegments": "Connection details are not available for this download.",
  "win.progress.limitLabel": "Global speed limit (MB/s)",
  "win.progress.limitHint": "0 = unlimited. Applies to all active downloads.",
  "win.progress.afterCompleteWindow": "Show the completion window when the download finishes",
  "win.progress.afterNotification": "Show a notification when the download finishes",
  "win.progress.afterHint": "These options apply to all downloads.",
  "win.progress.percentOf": "{percent}% of {total}",
  "win.complete.title": "Download complete",
  "win.complete.line": "{size} ({bytes} bytes) downloaded",
  "win.complete.address": "Address",
  "win.complete.saved": "File saved to",
  "win.complete.open": "Open",
  "win.complete.openWith": "Open with\u2026",
  "win.complete.folder": "Open folder",
  "win.complete.close": "Close",
  "win.complete.dontShow": "Do not show this dialog again",
  "win.duplicate.title": "Same download link",
  "win.duplicate.url": "URL",
  "win.duplicate.explain": "This file download is already in your download list. You can choose one of the options below, or press Cancel to skip the download.",
  "win.duplicate.number": "Add the file with a numbered file name",
  "win.duplicate.overwrite": "Add the file and overwrite the default file",
  "win.duplicate.continue": "If the default file is complete, show the Download Complete dialog; otherwise continue",
  "win.duplicate.ok": "OK",
  "win.duplicate.cancel": "Cancel",
  "win.duplicate.remember": "Remember my choice and do not show this dialog again.",
  "win.duplicate.hint": "You can change this choice later in Settings \u2192 General.",
  "win.duplicate.file": "File",
  "win.duplicate.status": "Status",
  "set.notify.progressWindow": "Show the download progress window",
  "set.notify.completeWindow": "Show the completion window after download",
  "set.duplicatePolicy": "When the same link is added again",
  "set.duplicatePolicyHint": "Choose what happens when a URL that is already in the list is added again",
  "set.duplicatePolicy.ask": "Ask me",
  "set.duplicatePolicy.number": "Add as a numbered copy",
  "set.duplicatePolicy.overwrite": "Overwrite the existing file",
  "set.duplicatePolicy.continue": "Continue the existing download",
  // --- Medya (sosyal medya) penceresi ---
  "media.title": "Media download",
  "media.probing": "Fetching available formats\u2026",
  "media.formats": "Formats",
  "media.quality": "Quality",
  "media.audioOnly": "Audio only (M4A/MP3)",
  "media.best": "Best (video + audio)",
  "media.download": "Download",
  "media.noFormats": "No formats found.",
  "media.needsCookies": "Sign-in required content: enable cookie passing in Settings \u2192 Social media.",
  "media.ffmpegMissing": "ffmpeg was not found. Separate video+audio streams cannot be merged; a lower quality single file will be chosen.",
  "media.resolution": "Resolution",
  "media.type": "Type",
  "media.size": "Size",
  "media.note": "Note",
  "media.site": "Site",
  "media.duration": "Duration",
  "media.thumbnailAlt": "Thumbnail",
  // --- Torrent ---
  "torrent.title": "Add torrent",
  "torrent.magnet": "Magnet link or .torrent path",
  "torrent.pick": "Choose .torrent file\u2026",
  "torrent.saveTo": "Save to",
  "torrent.add": "Add torrent",
  "torrent.peers": "Peers",
  "torrent.downSpeed": "Down",
  "torrent.upSpeed": "Up",
  "torrent.ratio": "Ratio",
  "torrent.seeding": "Seeding",
  "torrent.downloading": "Downloading",
  "torrent.metadata": "Fetching metadata\u2026",
  "torrent.invalid": "Invalid magnet link or torrent file.",
  "torrent.dhtDisabled": "DHT is disabled in settings; only tracker peers will be used.",
  // --- Ayarlar ---
  "settings.title": "Settings",
  "settings.tab.general": "General",
  "settings.tab.notifications": "Notifications",
  "settings.tab.social": "Social media",
  "settings.tab.torrent": "Torrent",
  "settings.tab.extension": "Extension",
  "settings.tab.about": "About",
  "set.language": "Language",
  "set.theme": "Theme",
  "set.theme.light": "Light",
  "set.theme.dark": "Dark",
  "set.theme.system": "System",
  "set.downloadDir": "Default download folder",
  "set.maxConcurrent": "Simultaneous downloads",
  "set.maxConcurrentHint": "How many downloads run at the same time",
  "set.segments": "Connections per file",
  "set.segmentsHint": "More connections can mean higher speed on supporting servers",
  "set.speedLimit": "Speed limit (MB/s)",
  "set.speedLimitHint": "0 = unlimited",
  "set.autoStart": "Start downloads automatically",
  "set.confirmBefore": "Ask for confirmation before downloading",
  "set.confirmBeforeHint": "Opens the File Download Information window when a download is requested",
  "set.monitorClipboard": "Watch clipboard for links",
  "set.startOnBoot": "Start with Windows",
  "set.startMinimized": "Start minimized to tray",
  "set.connectionsNote": "Values above 8 connections may be blocked by some servers.",
  "set.notify.onStart": "Before download starts",
  "set.notify.onProgress": "Progress updates (25% / 50% / 75%)",
  "set.notify.onComplete": "When download finishes",
  "set.notify.onError": "When download fails",
  "set.notify.systemToasts": "Windows toast notifications",
  "set.notify.inAppToasts": "In-app notification balloons",
  "set.notify.playSound": "Play a sound when finished",
  "set.notify.test": "Send test notifications",
  "set.notify.hint": "Notifications appear before, during and after each download.",
  "set.social.ytdlpPath": "yt-dlp location",
  "set.social.ytdlpAuto": "yt-dlp not found. Download it now? (about 3 MB, from the official GitHub release)",
  "set.social.ytdlpDownload": "Download yt-dlp",
  "set.social.ytdlpDownloading": "Downloading yt-dlp\u2026",
  "set.social.ytdlpReady": "yt-dlp is ready.",
  "set.social.ffmpegPath": "ffmpeg location",
  "set.social.ffmpegHint": "Required to merge separate video+audio streams and to convert to MP3.",
  "set.social.passCookies": "Pass browser cookies (for private/age-restricted content)",
  "set.social.passCookiesHint": "Cookies of the page you download from are sent to yt-dlp.",
  "set.social.preferredQuality": "Preferred quality",
  "set.social.sitesHint": "Supported: YouTube, Instagram, Facebook, Reddit, TikTok, X/Twitter, Vimeo, Twitch, Kick, Dailymotion, SoundCloud, Pinterest, VK, Bilibili and 1000+ more sites.",
  "set.torrent.saveDir": "Torrent download folder",
  "set.torrent.port": "Listen port (0 = random)",
  "set.torrent.maxConcurrent": "Simultaneous torrents",
  "set.torrent.uploadLimit": "Upload limit (MB/s)",
  "set.torrent.seedRatio": "Stop seeding at ratio",
  "set.torrent.dht": "Enable DHT (trackerless downloads)",
  "set.torrent.utp": "Enable \xB5TP",
  "set.ext.enabled": "Listen for browser extension",
  "set.ext.port": "Local port",
  "set.ext.pairingCode": "Pairing code",
  "set.ext.pairingHint": "Enter this code in the extension popup once; it is then remembered on both sides.",
  "set.ext.regenerate": "New code",
  "set.ext.revoke": "Reset pairing",
  "set.ext.revokeHint": "Creates a new token and disconnects every paired browser. Extensions must pair again with the code above.",
  "set.ext.status": "Status",
  "set.ext.connectedClients": "Connected browsers",
  "set.ext.noClients": "No browser connected yet",
  "set.ext.installHint": "Chrome/Edge/Brave: chrome://extensions \u2192 Developer mode \u2192 Load unpacked \u2192 extension/chromium folder. For Firefox/Zen use the profile installer below.",
  "set.ext.openDir": "Open extension folder",
  "set.ext.geckoTitle": "Firefox / Zen Browser",
  "set.ext.geckoCardTitle": "Persistent install",
  "set.ext.geckoNone": "Firefox or Zen Browser was not found. If it is installed in a custom folder, load extension/gecko/manifest.json via about:debugging instead.",
  "set.ext.geckoHint": "Persistent install: the extension is written into the selected profile and the profile is prepared to load it (signature check + side-load protection off). Restart the browser afterwards; the extension then loads on every start.",
  "set.ext.geckoSignHint": "Note: Firefox/Zen block unsigned and side-loaded add-ons by default. The installer sets xpinstall.signatures.required=false and extensions.autoDisableScopes=0 in the chosen profile; signed add-ons keep working normally.",
  "set.ext.geckoInstall": "Install",
  "set.ext.geckoReinstall": "Reinstall",
  "set.ext.geckoInstalledBadge": "Installed",
  "set.ext.geckoInstalled": "Installed. Restart the browser to load the extension.",
  "set.ext.geckoInstalledRunning": "Installed. The browser is open \u2014 the extension loads after a restart.",
  "set.ext.geckoRemoved": "Removed. Restart the browser.",
  "set.ext.geckoError": "Install failed",
  "set.ext.floatPanel": "Floating IDMS panel",
  "set.ext.floatPanelHint": "Shows a small IDMS badge inside the page over playing video/audio (like IDM). It only exists in the browser tab, never over other apps. Click the badge for download options.",
  "float.video": "Video (best)",
  "float.audio": "Audio only",
  "float.formats": "Formats\u2026",
  "float.openApp": "Open IDMS",
  "float.close": "Close",
  "float.queued": "Added to the IDMS queue",
  "float.added": "Download added to the queue",
  "float.unsupported": "This media address cannot be downloaded directly",
  "float.noFormats": "No quality list found for this media",
  "float.needYtdlp": "Install yt-dlp (Settings \u2192 Social media) to list qualities",
  "float.probeTimeout": "Quality list timed out",
  "float.probeFailed": "Quality list could not be read",
  "float.pageNotSpecific": "Open the post/video page to list qualities (this page is not a single video)",
  "float.needLogin": "This content needs login cookies (Settings \u2192 Social media)",
  "float.unavailable": "Video not found or not accessible",
  "set.about.version": "Version",
  "set.about.license": "MIT License",
  "set.about.credits": "Built with Electron, webtorrent and yt-dlp.",
  // --- Bildirimler (main tarafından da kullanılır) ---
  "notify.start.title": "Download starting",
  "notify.start.body": "\u201C{name}\u201D will be downloaded to {folder}.",
  "notify.start.actionApprove": "Start",
  "notify.start.actionCancel": "Cancel",
  "notify.start.requested": "New download requested",
  "notify.progress.title": "Downloading",
  "notify.progress.body": "{name} \u2014 {percent}% \xB7 {speed}/s \xB7 {remaining} left",
  "notify.complete.title": "Download complete",
  "notify.complete.body": "\u201C{name}\u201D downloaded ({size} in {duration}).",
  "notify.complete.actionOpen": "Open",
  "notify.complete.actionFolder": "Folder",
  "notify.error.title": "Download failed",
  "notify.error.body": "\u201C{name}\u201D failed: {error}",
  "notify.test.start": "This is a pre-download notification.",
  "notify.test.progress": "This is an in-progress notification.",
  "notify.test.complete": "This is a completion notification.",
  "notify.test.error": "This is an error notification.",
  "notify.clipboard.title": "Link detected",
  "notify.clipboard.body": "Download \u201C{url}\u201D?",
  "notify.toastQueue": "Notification center",
  // --- Hata mesajları ---
  "err.network": "Network error",
  "err.notFound": "File not found (404)",
  "err.forbidden": "Access denied (403)",
  "err.rangeUnsupported": "Server does not support resume",
  "err.diskFull": "Not enough disk space",
  "err.canceled": "Canceled by user",
  "err.ytdlpMissing": "yt-dlp not found. Configure it in Settings \u2192 Social media.",
  "err.ffmpegMissing": "ffmpeg not found.",
  "err.queued": "Waiting in queue",
  "err.tooManyRetries": "Too many retries, giving up",
  "err.savePathTaken": "File already exists",
  "err.generic": "Unexpected error",
  // --- Eklenti olayları ---
  "ext.event.connected": "Browser extension connected",
  "ext.event.disconnected": "Browser extension disconnected",
  "ext.event.detected": "{count} downloadable media found on {title}",
  "ext.event.requested": "Download requested from the browser",
  // --- Menü / diğer ---
  "menu.selectAll": "Select all",
  "menu.notifications": "Notifications",
  "menu.markAllRead": "Mark all as read",
  "menu.clearAll": "Clear all",
  "menu.noNotifications": "No notifications",
  "empty.title": "No downloads here",
  "empty.hint": "Use \u201CAdd URL\u201D, drag a link in, or install the browser extension.",
  "drop.hint": "Drop links here to download",
  "search.placeholder": "Filter downloads\u2026",
  "tray.open": "Open IDMS",
  "tray.quit": "Quit",
  "window.minimize": "Minimize",
  "window.maximize": "Maximize",
  "window.close": "Close"
};
var tr = {
  "app.name": "IDMS",
  "app.tagline": "\u0130ndirme Y\xF6neticisi",
  "common.ok": "Tamam",
  "common.cancel": "\u0130ptal",
  "common.close": "Kapat",
  "common.save": "Kaydet",
  "common.apply": "Uygula",
  "common.delete": "Sil",
  "common.remove": "Kald\u0131r",
  "common.browse": "G\xF6zat\u2026",
  "common.copy": "Kopyala",
  "common.copied": "Kopyaland\u0131",
  "common.search": "Ara",
  "common.all": "T\xFCm\xFC",
  "common.none": "Yok",
  "common.yes": "Evet",
  "common.no": "Hay\u0131r",
  "common.enabled": "A\xE7\u0131k",
  "common.disabled": "Kapal\u0131",
  "common.loading": "Y\xFCkleniyor\u2026",
  "common.error": "Hata",
  "common.retry": "Tekrar dene",
  "common.test": "Test et",
  "common.reset": "S\u0131f\u0131rla",
  "common.default": "Varsay\u0131lan",
  "common.unknown": "Bilinmiyor",
  "common.unlimited": "S\u0131n\u0131rs\u0131z",
  "common.bytes": "B",
  "common.kb": "KB",
  "common.mb": "MB",
  "common.gb": "GB",
  "common.tb": "TB",
  "common.perSecond": "/sn",
  "toolbar.add": "URL Ekle",
  "toolbar.addHint": "URL ile yeni indirme ekle",
  "toolbar.start": "Ba\u015Flat",
  "toolbar.startHint": "Se\xE7ili indirmeyi ba\u015Flat",
  "toolbar.pause": "Duraklat",
  "toolbar.pauseHint": "Se\xE7ili indirmeyi duraklat",
  "toolbar.remove": "Kald\u0131r",
  "toolbar.removeHint": "Se\xE7ili indirmeyi listeden kald\u0131r",
  "toolbar.settings": "Ayarlar",
  "toolbar.settingsHint": "Ayarlar\u0131 a\xE7",
  "toolbar.extension": "Eklenti",
  "toolbar.extensionHint": "Taray\u0131c\u0131 eklentisi durumu",
  "toolbar.notify": "Bildirimler",
  "toolbar.notifyHint": "Bildirim merkezi",
  "toolbar.completed": "Tamamlananlar",
  "toolbar.completedHint": "\u0130ndirme klas\xF6r\xFCn\xFC a\xE7",
  "toolbar.newTorrent": "Torrent",
  "cat.downloading": "\u0130ndiriliyor",
  "cat.completed": "Tamamlanan",
  "cat.queued": "S\u0131rada",
  "cat.scheduled": "Zamanlanm\u0131\u015F",
  "cat.error": "Ba\u015Far\u0131s\u0131z",
  "cat.paused": "Duraklat\u0131lan",
  "cat.video": "Video",
  "cat.audio": "Ses",
  "cat.archive": "Ar\u015Fiv",
  "cat.program": "Programlar",
  "cat.document": "Belgeler",
  "cat.other": "Di\u011Fer",
  "col.name": "Ad",
  "col.size": "Boyut",
  "col.speed": "H\u0131z",
  "col.eta": "Kalan s\xFCre",
  "col.status": "Durum",
  "col.progress": "\u0130lerleme",
  "col.added": "Eklenme",
  "col.category": "Kategori",
  "col.type": "T\xFCr",
  "state.queued": "S\u0131rada",
  "state.resolving": "\xC7\xF6z\xFCmleniyor\u2026",
  "state.confirming": "Onay bekleniyor",
  "state.downloading": "\u0130ndiriliyor",
  "state.paused": "Duraklat\u0131ld\u0131",
  "state.completed": "Tamamland\u0131",
  "state.error": "Ba\u015Far\u0131s\u0131z",
  "state.canceled": "\u0130ptal edildi",
  "state.scheduled": "Zamanland\u0131",
  "action.resume": "Devam et",
  "action.restart": "Yeniden ba\u015Flat",
  "action.openFile": "Dosyay\u0131 a\xE7",
  "action.openFolder": "Klas\xF6r\xFC a\xE7",
  "action.showInFolder": "Klas\xF6rde g\xF6ster",
  "action.queue": "Kuyru\u011Fa ekle",
  "action.copyUrl": "URL kopyala",
  "action.properties": "\xD6zellikler",
  "action.clearCompleted": "Tamamlananlar\u0131 temizle",
  "action.schedule": "Zamanla",
  "action.cancelSchedule": "Zamanlamay\u0131 iptal et",
  "detail.title": "Dosya ayr\u0131nt\u0131lar\u0131",
  "detail.connections": "Ba\u011Flant\u0131",
  "detail.torrentPeers": "E\u015F",
  "detail.torrentRatio": "Oran",
  "status.downloads": "indirme",
  "status.active": "Etkin",
  "status.totalSpeed": "Toplam h\u0131z",
  "status.queued": "S\u0131rada",
  "status.done": "Bug\xFCn biten",
  "status.extensionConnected": "Eklenti ba\u011Fl\u0131",
  "status.extensionDisconnected": "Eklenti ba\u011Fl\u0131 de\u011Fil",
  "status.extensionHelp": "Tek t\u0131kla indirme i\xE7in eklentiyi taray\u0131c\u0131na y\xFCkleyin.",
  "add.title": "\u0130ndirme ekle",
  "add.url": "Adres (URL)",
  "add.name": "Dosya ad\u0131",
  "add.saveTo": "Nereye kaydedilsin",
  "add.category": "Kategori",
  "add.startNow": "Hemen ba\u015Flat",
  "add.submit": "\u0130ndir",
  "add.probing": "Adres kontrol ediliyor\u2026",
  "add.probeFailed": "Adres kontrol edilemedi. Yine de indirebilirsiniz.",
  "add.sizeUnknown": "Boyut bilinmiyor",
  "add.supportsRange": "\xC7oklu ba\u011Flant\u0131 destekleniyor",
  "add.noRange": "Tek ba\u011Flant\u0131",
  "add.invalidUrl": "Ge\xE7erli bir http(s) URL\u2019si girin.",
  "add.clipboardDetected": "Panoda bir ba\u011Flant\u0131 alg\u0131land\u0131.",
  "add.paste": "Yap\u0131\u015Ft\u0131r",
  "confirm.title": "Dosya indir",
  "confirm.question": "Bu dosya indirilsin mi?",
  "confirm.download": "\u0130ndir",
  "confirm.later": "Sonra karar ver",
  "confirm.from": "Kaynak",
  // --- IDM tarzı indirme pencereleri ---
  "win.add.title": "Dosya \u0130ndirme Bilgisi",
  "win.add.url": "URL",
  "win.add.category": "Kategori",
  "win.add.saveAs": "Kaydet",
  "win.add.fileName": "Dosya ad\u0131",
  "win.add.rememberCategory": '"{category}" kategorisi i\xE7in bu yolu hat\u0131rla',
  "win.add.rememberDir": "Hat\u0131rlanacak klas\xF6r",
  "win.add.description": "A\xE7\u0131klama",
  "win.add.preview": "\xD6nizleme",
  "win.add.later": "Daha Sonra \u0130ndir",
  "win.add.start": "\u0130ndirmeyi Ba\u015Flat",
  "win.add.newCategory": "Yeni kategori",
  "win.add.newCategoryPlaceholder": "Klas\xF6r ad\u0131",
  "win.add.addCategory": "Ekle",
  "win.add.sizeUnknown": "Boyut bilinmiyor",
  "win.add.probing": "Adres kontrol ediliyor\u2026",
  "win.add.invalidUrl": "Ge\xE7erli bir http(s) URL\u2019si girin.",
  "win.add.categoryHint": "Dosyalar se\xE7ilen kategori klas\xF6r\xFCn\xFCn alt\u0131na kaydedilir.",
  "win.progress.title": "\u0130ndirme durumu",
  "win.progress.tabStatus": "\u0130ndirme durumu",
  "win.progress.tabLimiter": "H\u0131z S\u0131n\u0131rlay\u0131c\u0131",
  "win.progress.tabAfter": "Tamamland\u0131ktan sonraki se\xE7enekler",
  "win.progress.url": "URL",
  "win.progress.status": "Durum",
  "win.progress.size": "Dosya boyutu",
  "win.progress.downloaded": "\u0130ndirilen",
  "win.progress.speed": "Aktar\u0131m oran\u0131",
  "win.progress.eta": "Kalan s\xFCre",
  "win.progress.resume": "Devam etme \xF6zelli\u011Fi",
  "win.progress.connecting": "Ba\u011Flan\u0131l\u0131yor\u2026",
  "win.progress.receiving": "Veri al\u0131n\u0131yor\u2026",
  "win.progress.waiting": "Bekliyor\u2026",
  "win.progress.done": "Tamamland\u0131",
  "win.progress.paused": "Duraklat\u0131ld\u0131",
  "win.progress.canceled": "\u0130ptal edildi",
  "win.progress.failed": "Ba\u015Far\u0131s\u0131z",
  "win.progress.detailsHide": "Ayr\u0131nt\u0131lar\u0131 gizle",
  "win.progress.detailsShow": "Ayr\u0131nt\u0131lar\u0131 g\xF6ster",
  "win.progress.pause": "Duraklat",
  "win.progress.resumeBtn": "Devam ettir",
  "win.progress.cancel": "\u0130ptal",
  "win.progress.connHead": "Ba\u011Flant\u0131lara g\xF6re indirme ilerlemesi ve ba\u011Flant\u0131lar\u0131n ba\u015Flang\u0131\xE7 konumlar\u0131",
  "win.progress.tableNo": "N.",
  "win.progress.tableReceived": "\u0130ndirilen",
  "win.progress.tableInfo": "Bilgi",
  "win.progress.noSegments": "Bu indirme i\xE7in ba\u011Flant\u0131 ayr\u0131nt\u0131s\u0131 yok.",
  "win.progress.limitLabel": "Genel h\u0131z s\u0131n\u0131r\u0131 (MB/sn)",
  "win.progress.limitHint": "0 = s\u0131n\u0131rs\u0131z. T\xFCm etkin indirmelere uygulan\u0131r.",
  "win.progress.afterCompleteWindow": "\u0130ndirme bitince tamamland\u0131 penceresini g\xF6ster",
  "win.progress.afterNotification": "\u0130ndirme bitince bildirim g\xF6ster",
  "win.progress.afterHint": "Bu se\xE7enekler t\xFCm indirmelere uygulan\u0131r.",
  "win.progress.percentOf": "{total} dosyas\u0131n\u0131n %{percent} kadar\u0131",
  "win.complete.title": "\u0130ndirme tamamland\u0131",
  "win.complete.line": "{size} ({bytes} Bayt) indirildi",
  "win.complete.address": "Adres",
  "win.complete.saved": "Dosya kaydedildi",
  "win.complete.open": "A\xE7",
  "win.complete.openWith": "Birlikte a\xE7\u2026",
  "win.complete.folder": "Klas\xF6r\xFC a\xE7",
  "win.complete.close": "Kapat",
  "win.complete.dontShow": "Bu ileti\u015Fim kutusunu tekrar g\xF6sterme",
  "win.duplicate.title": "Ayn\u0131 indirme ba\u011Flant\u0131s\u0131",
  "win.duplicate.url": "URL",
  "win.duplicate.explain": "Bu dosya indirme listenizde zaten mevcut. A\u015Fa\u011F\u0131daki se\xE7eneklerden birini se\xE7ebilir, veya indirmeyi atlamak i\xE7in \u0130ptal d\xFC\u011Fmesine basabilirsiniz.",
  "win.duplicate.number": "Dosyay\u0131 numaraland\u0131r\u0131lm\u0131\u015F dosya ad\u0131yla birlikte ekle",
  "win.duplicate.overwrite": "Dosyay\u0131 ekle ve varsay\u0131lan dosyan\u0131n \xFCzerine yaz",
  "win.duplicate.continue": "Varsay\u0131lan dosya tamamland\u0131ysa indirme tamamland\u0131 ileti\u015Fim kutusunu g\xF6ster; aksi halde devam et",
  "win.duplicate.ok": "Tamam",
  "win.duplicate.cancel": "\u0130ptal",
  "win.duplicate.remember": "Se\xE7imimi hat\u0131rla ve bu ileti\u015Fim kutusunu tekrar g\xF6sterme.",
  "win.duplicate.hint": "Se\xE7iminizi daha sonra Ayarlar \u2192 Genel b\xF6l\xFCm\xFCnde de\u011Fi\u015Ftirebilirsiniz.",
  "win.duplicate.file": "Dosya",
  "win.duplicate.status": "Durum",
  "set.notify.progressWindow": "\u0130ndirme s\u0131ras\u0131nda ilerleme penceresini g\xF6ster",
  "set.notify.completeWindow": "\u0130ndirme bitince tamamland\u0131 penceresini g\xF6ster",
  "set.duplicatePolicy": "Ayn\u0131 ba\u011Flant\u0131 tekrar eklenince",
  "set.duplicatePolicyHint": "Listede zaten olan bir adres yeniden eklenince ne yap\u0131laca\u011F\u0131n\u0131 se\xE7in",
  "set.duplicatePolicy.ask": "Bana sor",
  "set.duplicatePolicy.number": "Numaral\u0131 kopya olarak ekle",
  "set.duplicatePolicy.overwrite": "Mevcut dosyan\u0131n \xFCzerine yaz",
  "set.duplicatePolicy.continue": "Mevcut indirmeye devam et",
  "media.title": "Medya indirme",
  "media.probing": "Kullan\u0131labilir formatlar al\u0131n\u0131yor\u2026",
  "media.formats": "Formatlar",
  "media.quality": "Kalite",
  "media.audioOnly": "Sadece ses (M4A/MP3)",
  "media.best": "En iyi (video + ses)",
  "media.download": "\u0130ndir",
  "media.noFormats": "Format bulunamad\u0131.",
  "media.needsCookies": "Giri\u015F gerektiren i\xE7erik: Ayarlar \u2192 Sosyal medyadan \xE7erez aktar\u0131m\u0131n\u0131 a\xE7\u0131n.",
  "media.ffmpegMissing": "ffmpeg bulunamad\u0131. Ayr\u0131 video+ses ak\u0131\u015Flar\u0131 birle\u015Ftirilemeyecek; daha d\xFC\u015F\xFCk tek dosya kalitesi se\xE7ilecek.",
  "media.resolution": "\xC7\xF6z\xFCn\xFCrl\xFCk",
  "media.type": "T\xFCr",
  "media.size": "Boyut",
  "media.note": "Not",
  "media.site": "Site",
  "media.duration": "S\xFCre",
  "media.thumbnailAlt": "K\xFC\xE7\xFCk resim",
  "torrent.title": "Torrent ekle",
  "torrent.magnet": "Magnet ba\u011Flant\u0131s\u0131 veya .torrent yolu",
  "torrent.pick": ".torrent dosyas\u0131 se\xE7\u2026",
  "torrent.saveTo": "Nereye kaydedilsin",
  "torrent.add": "Torrenti ekle",
  "torrent.peers": "E\u015F",
  "torrent.downSpeed": "\u0130ndirme",
  "torrent.upSpeed": "Y\xFCkleme",
  "torrent.ratio": "Oran",
  "torrent.seeding": "Y\xFCkleniyor (seed)",
  "torrent.downloading": "\u0130ndiriliyor",
  "torrent.metadata": "Meta verisi al\u0131n\u0131yor\u2026",
  "torrent.invalid": "Ge\xE7ersiz magnet ba\u011Flant\u0131s\u0131 veya torrent dosyas\u0131.",
  "torrent.dhtDisabled": "Ayarlar\u2019dan DHT kapal\u0131; yaln\u0131zca izleyici (tracker) e\u015Fleri kullan\u0131lacak.",
  "settings.title": "Ayarlar",
  "settings.tab.general": "Genel",
  "settings.tab.notifications": "Bildirimler",
  "settings.tab.social": "Sosyal medya",
  "settings.tab.torrent": "Torrent",
  "settings.tab.extension": "Eklenti",
  "settings.tab.about": "Hakk\u0131nda",
  "set.language": "Dil",
  "set.theme": "Tema",
  "set.theme.light": "A\xE7\u0131k",
  "set.theme.dark": "Koyu",
  "set.theme.system": "Sistem",
  "set.downloadDir": "Varsay\u0131lan indirme klas\xF6r\xFC",
  "set.maxConcurrent": "E\u015Fzamanl\u0131 indirme",
  "set.maxConcurrentHint": "Ayn\u0131 anda ka\xE7 indirme \xE7al\u0131\u015F\u0131r",
  "set.segments": "Dosya ba\u015F\u0131na ba\u011Flant\u0131",
  "set.segmentsHint": "Destekleyen sunucularda daha fazla ba\u011Flant\u0131 daha y\xFCksek h\u0131z sa\u011Flayabilir",
  "set.speedLimit": "H\u0131z s\u0131n\u0131r\u0131 (MB/sn)",
  "set.speedLimitHint": "0 = s\u0131n\u0131rs\u0131z",
  "set.autoStart": "\u0130ndirmeleri otomatik ba\u015Flat",
  "set.confirmBefore": "\u0130ndirmeden \xF6nce onay iste",
  "set.confirmBeforeHint": "\u0130ndirme istendi\u011Finde Dosya \u0130ndirme Bilgisi penceresini a\xE7ar",
  "set.monitorClipboard": "Panodaki ba\u011Flant\u0131lar\u0131 izle",
  "set.startOnBoot": "Windows ile ba\u015Flat",
  "set.startMinimized": "Simge durumunda ba\u015Flat",
  "set.connectionsNote": "8 ba\u011Flant\u0131 \xFCst\xFC de\u011Ferler baz\u0131 sunucularca engellenebilir.",
  "set.notify.onStart": "\u0130ndirme ba\u015Flarken",
  "set.notify.onProgress": "\u0130lerleme bildirimleri (%25 / %50 / %75)",
  "set.notify.onComplete": "\u0130ndirme bitince",
  "set.notify.onError": "\u0130ndirme hata verince",
  "set.notify.systemToasts": "Windows bildirimleri",
  "set.notify.inAppToasts": "Uygulama i\xE7i bildirim balonlar\u0131",
  "set.notify.playSound": "Bitince ses \xE7al",
  "set.notify.test": "Test bildirimi g\xF6nder",
  "set.notify.hint": "Bildirimler her indirme s\u0131ras\u0131nda \xF6ncesinde, s\u0131ras\u0131nda ve sonras\u0131nda g\xF6r\xFCn\xFCr.",
  "set.social.ytdlpPath": "yt-dlp konumu",
  "set.social.ytdlpAuto": "yt-dlp bulunamad\u0131. \u015Eimdi indirilsin mi? (yakla\u015F\u0131k 3 MB, resmi GitHub s\xFCr\xFCm\xFCnden)",
  "set.social.ytdlpDownload": "yt-dlp indir",
  "set.social.ytdlpDownloading": "yt-dlp indiriliyor\u2026",
  "set.social.ytdlpReady": "yt-dlp haz\u0131r.",
  "set.social.ffmpegPath": "ffmpeg konumu",
  "set.social.ffmpegHint": "Ayr\u0131 video+ses ak\u0131\u015Flar\u0131n\u0131 birle\u015Ftirmek ve MP3\u2019e d\xF6n\xFC\u015Ft\xFCrmek i\xE7in gerekir.",
  "set.social.passCookies": "Taray\u0131c\u0131 \xE7erezlerini aktar (gizli/ya\u015F s\u0131n\u0131rl\u0131 i\xE7erik i\xE7in)",
  "set.social.passCookiesHint": "\u0130ndirdi\u011Finiz sayfan\u0131n \xE7erezleri yt-dlp\u2019ye g\xF6nderilir.",
  "set.social.preferredQuality": "Tercih edilen kalite",
  "set.social.sitesHint": "Desteklenen: YouTube, Instagram, Facebook, Reddit, TikTok, X/Twitter, Vimeo, Twitch, Kick, Dailymotion, SoundCloud, Pinterest, VK, Bilibili ve 1000\u2019den fazla site.",
  "set.torrent.saveDir": "Torrent indirme klas\xF6r\xFC",
  "set.torrent.port": "Dinleme portu (0 = rastgele)",
  "set.torrent.maxConcurrent": "E\u015Fzamanl\u0131 torrent",
  "set.torrent.uploadLimit": "Y\xFCkleme s\u0131n\u0131r\u0131 (MB/sn)",
  "set.torrent.seedRatio": "Oranda y\xFCklemeyi durdur",
  "set.torrent.dht": "DHT\u2019yi a\xE7 (izleyicisiz indirme)",
  "set.torrent.utp": "\xB5TP\u2019yi a\xE7",
  "set.ext.enabled": "Taray\u0131c\u0131 eklentisini dinle",
  "set.ext.port": "Yerel port",
  "set.ext.pairingCode": "E\u015Fle\u015Ftirme kodu",
  "set.ext.pairingHint": "Bu kodu eklentiye bir kez girin; iki tarafta da kal\u0131c\u0131 olarak hat\u0131rlan\u0131r.",
  "set.ext.regenerate": "Yeni kod",
  "set.ext.revoke": "E\u015Fle\u015Ftirmeyi s\u0131f\u0131rla",
  "set.ext.revokeHint": "Yeni bir token \xFCretir ve e\u015Fle\u015Fmi\u015F t\xFCm taray\u0131c\u0131lar\u0131n ba\u011Flant\u0131s\u0131n\u0131 keser. Eklentilerin yukar\u0131daki kodla yeniden e\u015Fle\u015Fmesi gerekir.",
  "set.ext.status": "Durum",
  "set.ext.connectedClients": "Ba\u011Fl\u0131 taray\u0131c\u0131lar",
  "set.ext.noClients": "Hen\xFCz ba\u011Fl\u0131 taray\u0131c\u0131 yok",
  "set.ext.installHint": "Chrome/Edge/Brave: chrome://extensions \u2192 Geli\u015Ftirici modu \u2192 Paketlenmemi\u015F y\xFCkle \u2192 extension/chromium klas\xF6r\xFC. Firefox/Zen i\xE7in a\u015Fa\u011F\u0131daki profil kurulumunu kullan\u0131n.",
  "set.ext.openDir": "Eklenti klas\xF6r\xFCn\xFC a\xE7",
  "set.ext.geckoTitle": "Firefox / Zen Browser",
  "set.ext.geckoCardTitle": "Kal\u0131c\u0131 kurulum",
  "set.ext.geckoNone": "Firefox veya Zen Browser bulunamad\u0131. Taray\u0131c\u0131 \xF6zel bir klas\xF6re kuruluysa eklentiyi about:debugging ile extension/gecko/manifest.json dosyas\u0131ndan y\xFCkleyin.",
  "set.ext.geckoHint": "Kal\u0131c\u0131 kurulum: eklenti se\xE7ilen profile yaz\u0131l\u0131r ve profil onu y\xFCklemek i\xE7in haz\u0131rlan\u0131r (imza denetimi + sideload korumas\u0131 kapal\u0131). Ard\u0131ndan taray\u0131c\u0131y\u0131 yeniden ba\u015Flat\u0131n; eklenti her a\xE7\u0131l\u0131\u015Fta y\xFCklenir.",
  "set.ext.geckoSignHint": "Not: Firefox/Zen imzas\u0131z ve profile b\u0131rak\u0131lan eklentileri varsay\u0131lan olarak engeller. Kurulum, se\xE7ilen profilde xpinstall.signatures.required=false ve extensions.autoDisableScopes=0 ayarlar\u0131n\u0131 yazar; imzal\u0131 eklentiler normal \xE7al\u0131\u015Fmaya devam eder.",
  "set.ext.geckoInstall": "Kur",
  "set.ext.geckoReinstall": "Yeniden kur",
  "set.ext.geckoInstalledBadge": "Kurulu",
  "set.ext.geckoInstalled": "Kuruldu. Eklentinin y\xFCklenmesi i\xE7in taray\u0131c\u0131y\u0131 yeniden ba\u015Flat\u0131n.",
  "set.ext.geckoInstalledRunning": "Kuruldu. Taray\u0131c\u0131 a\xE7\u0131k; eklenti yeniden ba\u015Flat\u0131nca y\xFCklenir.",
  "set.ext.geckoRemoved": "Kald\u0131r\u0131ld\u0131. Taray\u0131c\u0131y\u0131 yeniden ba\u015Flat\u0131n.",
  "set.ext.geckoError": "Kurulum ba\u015Far\u0131s\u0131z",
  "set.ext.floatPanel": "Y\xFCzen IDMS paneli",
  "set.ext.floatPanelHint": "Oynayan video/sesin \xFCzerinde, sayfan\u0131n i\xE7inde k\xFC\xE7\xFCk bir IDMS rozeti g\xF6sterir (IDM gibi). Yaln\u0131zca taray\u0131c\u0131 sekmesinde bulunur, ba\u015Fka uygulamalar\u0131n \xFCzerine \xE7\u0131kmaz. \u0130ndirme se\xE7enekleri i\xE7in rozete t\u0131klay\u0131n.",
  "float.video": "Video (en iyi)",
  "float.audio": "Sadece ses",
  "float.formats": "Formatlar\u2026",
  "float.openApp": "IDMS'i a\xE7",
  "float.close": "Kapat",
  "float.queued": "IDMS kuyru\u011Funa eklendi",
  "float.added": "\u0130ndirme kuyru\u011Fa eklendi",
  "float.unsupported": "Bu medya adresi do\u011Frudan indirilemiyor",
  "float.noFormats": "Bu medya i\xE7in kalite listesi bulunamad\u0131",
  "float.needYtdlp": "Kaliteleri listelemek i\xE7in yt-dlp kurun (Ayarlar \u2192 Sosyal medya)",
  "float.probeTimeout": "Kalite listesi zaman a\u015F\u0131m\u0131na u\u011Frad\u0131",
  "float.probeFailed": "Kalite listesi okunamad\u0131",
  "float.pageNotSpecific": "G\xF6nderi/video sayfas\u0131n\u0131 a\xE7\u0131nca kaliteler listelenir (bu sayfa tek bir video de\u011Fil)",
  "float.needLogin": "Bu i\xE7erik i\xE7in oturum \xE7erezi gerekiyor (Ayarlar \u2192 Sosyal medya)",
  "float.unavailable": "Video bulunamad\u0131 veya eri\u015Fime kapal\u0131",
  "set.about.version": "S\xFCr\xFCm",
  "set.about.license": "MIT lisans\u0131",
  "set.about.credits": "Electron, webtorrent ve yt-dlp ile yap\u0131ld\u0131.",
  "notify.start.title": "\u0130ndirme ba\u015Fl\u0131yor",
  "notify.start.body": "\u201C{name}\u201D \u015Fu klas\xF6re indirilecek: {folder}.",
  "notify.start.actionApprove": "Ba\u015Flat",
  "notify.start.actionCancel": "\u0130ptal",
  "notify.start.requested": "Yeni indirme istendi",
  "notify.progress.title": "\u0130ndiriliyor",
  "notify.progress.body": "{name} \u2014 %{percent} \xB7 {speed}/sn \xB7 {remaining} kald\u0131",
  "notify.complete.title": "\u0130ndirme tamamland\u0131",
  "notify.complete.body": "\u201C{name}\u201D indirildi ({size} i\xE7inde {duration}).",
  "notify.complete.actionOpen": "A\xE7",
  "notify.complete.actionFolder": "Klas\xF6r",
  "notify.error.title": "\u0130ndirme ba\u015Far\u0131s\u0131z oldu",
  "notify.error.body": "\u201C{name}\u201D ba\u015Far\u0131s\u0131z: {error}",
  "notify.test.start": "Bu bir indirme \xF6ncesi bildirimdir.",
  "notify.test.progress": "Bu bir ilerleme bildirimidir.",
  "notify.test.complete": "Bu bir tamamlanma bildirimidir.",
  "notify.test.error": "Bu bir hata bildirimidir.",
  "notify.clipboard.title": "Ba\u011Flant\u0131 alg\u0131land\u0131",
  "notify.clipboard.body": "\u201C{url}\u201D indirilsin mi?",
  "notify.toastQueue": "Bildirim merkezi",
  "err.network": "A\u011F hatas\u0131",
  "err.notFound": "Dosya bulunamad\u0131 (404)",
  "err.forbidden": "Eri\u015Fim reddedildi (403)",
  "err.rangeUnsupported": "Sunucu devam ettirmeyi desteklemiyor",
  "err.diskFull": "Yeterli disk alan\u0131 yok",
  "err.canceled": "Kullan\u0131c\u0131 taraf\u0131ndan iptal edildi",
  "err.ytdlpMissing": "yt-dlp bulunamad\u0131. Ayarlar \u2192 Sosyal medyadan yap\u0131land\u0131r\u0131n.",
  "err.ffmpegMissing": "ffmpeg bulunamad\u0131.",
  "err.queued": "S\u0131rada bekliyor",
  "err.tooManyRetries": "\xC7ok fazla deneme, vazge\xE7ildi",
  "err.savePathTaken": "Dosya zaten var",
  "err.generic": "Beklenmeyen hata",
  "ext.event.connected": "Taray\u0131c\u0131 eklentisi ba\u011Fland\u0131",
  "ext.event.disconnected": "Taray\u0131c\u0131 eklentisi ba\u011Flant\u0131s\u0131 kesildi",
  "ext.event.detected": "{title} \xFCzerinde {count} indirilebilir medya bulundu",
  "ext.event.requested": "Taray\u0131c\u0131dan indirme istendi",
  "menu.selectAll": "T\xFCm\xFCn\xFC se\xE7",
  "menu.notifications": "Bildirimler",
  "menu.markAllRead": "T\xFCm\xFCn\xFC okundu i\u015Faretle",
  "menu.clearAll": "T\xFCm\xFCn\xFC temizle",
  "menu.noNotifications": "Bildirim yok",
  "empty.title": "Burada indirme yok",
  "empty.hint": "\u201CURL Ekle\u201D kullan\u0131n, ba\u011Flant\u0131y\u0131 s\xFCr\xFCkleyin ya da taray\u0131c\u0131 eklentisini kurun.",
  "drop.hint": "\u0130ndirmek i\xE7in ba\u011Flant\u0131lar\u0131 buraya b\u0131rak\u0131n",
  "search.placeholder": "\u0130ndirmeleri s\xFCz\u2026",
  "tray.open": "IDMS\u2019yi a\xE7",
  "tray.quit": "\xC7\u0131k\u0131\u015F",
  "window.minimize": "Simge durumuna k\xFC\xE7\xFClt",
  "window.maximize": "Ekran\u0131 kapla",
  "window.close": "Kapat"
};
var dictionaries = { en, tr };
function translate(lang, key, params) {
  const dict = dictionaries[lang] ?? en;
  let s = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// src/main/lang.ts
var currentLang = "tr";
function t(key, params) {
  return translate(currentLang, key, params);
}

// src/main/engine/manager.ts
var CATEGORY_BY_EXT = {
  ".mp4": "video",
  ".mkv": "video",
  ".avi": "video",
  ".webm": "video",
  ".mov": "video",
  ".flv": "video",
  ".wmv": "video",
  ".m4v": "video",
  ".mpg": "video",
  ".mpeg": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".flac": "audio",
  ".aac": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".wma": "audio",
  ".opus": "audio",
  ".zip": "archive",
  ".rar": "archive",
  ".7z": "archive",
  ".tar": "archive",
  ".gz": "archive",
  ".bz2": "archive",
  ".xz": "archive",
  ".iso": "archive",
  ".exe": "program",
  ".msi": "program",
  ".apk": "program",
  ".deb": "program",
  ".rpm": "program",
  ".dmg": "program",
  ".app": "program",
  ".pdf": "document",
  ".doc": "document",
  ".docx": "document",
  ".xls": "document",
  ".xlsx": "document",
  ".ppt": "document",
  ".pptx": "document",
  ".txt": "document",
  ".epub": "document"
};
function categoryForFilename(name) {
  const ext = extname(name).toLowerCase();
  return CATEGORY_BY_EXT[ext] || "other";
}
var DownloadManager = class extends EventEmitter {
  items = [];
  jobs = /* @__PURE__ */ new Map();
  pausedSnapshots = /* @__PURE__ */ new Map();
  store;
  pumping = false;
  constructor(store) {
    super();
    this.setMaxListeners(100);
    this.store = store;
    this.items = store.loadDownloads();
    for (const it of this.items) {
      if (it.state === "downloading" || it.state === "resolving") {
        it.state = "paused";
      }
      if (it.state === "confirming") {
        it.state = "queued";
      }
      it.progress.speed = 0;
      it.progress.connections = 0;
    }
  }
  list() {
    return this.items;
  }
  get(id) {
    return this.items.find((i) => i.id === id);
  }
  /** Yeni indirme oluşturur. silent=false ise "confirming" durumunda onay bekler. */
  async add(req) {
    const settings = this.store.getSettings();
    const id = makeId();
    let name = req.name ? sanitizeFilename(req.name) : filenameFromUrl(req.url);
    let savePath = req.savePath;
    let totalBytes = req.totalBytes ?? 0;
    let supportsRange = req.supportsRange ?? false;
    const category = req.category || categoryForFilename(name);
    if (!savePath) {
      savePath = join2(settings.general.downloadDir, category, name);
      savePath = uniquePath(savePath);
    } else {
      savePath = uniquePath(savePath);
      name = basename(savePath);
    }
    const item = {
      id,
      kind: req.kind || "http",
      name,
      url: req.url,
      pageUrl: req.pageUrl,
      savePath,
      category,
      description: req.description,
      supportsRange,
      state: "queued",
      progress: {
        percent: 0,
        downloadedBytes: 0,
        totalBytes,
        speed: 0,
        etaSeconds: null,
        connections: 0
      },
      createdAt: Date.now()
    };
    this.items.unshift(item);
    if (req.supportsRange !== void 0) this.rangeSupport.set(id, supportsRange);
    if (req.headers && Object.keys(req.headers).length > 0) this.extraHeaders.set(id, req.headers);
    if (req.start === false) this.deferredStart.add(id);
    const wantsConfirm = !req.silent && settings.general.confirmBeforeDownload;
    if (wantsConfirm) {
      item.state = "confirming";
    }
    this.persist();
    this.emitUpdate();
    if (!totalBytes && req.kind !== "media") {
      void this.resolveInfo(item);
    }
    if (req.kind !== "media" && !wantsConfirm && settings.general.autoStart && req.start !== false) {
      this.schedulePump();
    }
    return item;
  }
  /** Aynı URL'ye ait (iptal edilmemiş) mevcut kaydı bulur. */
  findDuplicate(url) {
    const target = url.trim();
    return this.items.find((i) => i.url.trim() === target && i.state !== "canceled");
  }
  /** İlerleme penceresi için canlı segment anlık görüntüsü. */
  snapshotSegments(id) {
    const job = this.jobs.get(id);
    if (job) return job.snapshot();
    return this.pausedSnapshots.get(id) ?? [];
  }
  /** Sunucunun Range desteği biliniyorsa döndürür. */
  supportsRangeFor(id) {
    const item = this.get(id);
    if (item?.supportsRange !== void 0) return item.supportsRange;
    return this.rangeSupport.get(id);
  }
  /** URL hakkında başlık/boyut/Range bilgisini arka planda çözer. */
  async resolveInfo(item) {
    if (this.get(item.id) !== item) return;
    const prev = item.state;
    if (prev === "queued" || prev === "confirming" || prev === "resolving") {
      item.state = "resolving";
      this.emitUpdate();
    }
    const probe = await probeUrl(item.url, { pageUrl: item.pageUrl });
    if (this.get(item.id) !== item) return;
    if (probe.ok) {
      item.progress.totalBytes = probe.sizeBytes ?? 0;
      const resolvedName = probe.name;
      if ((!item.name || item.name === "download") && resolvedName && resolvedName !== "download") {
        item.name = resolvedName;
        item.category = item.category === "other" ? categoryForFilename(resolvedName) : item.category;
        item.savePath = uniquePath(join2(dirname2(item.savePath), resolvedName));
      }
      this.holdRange(item, probe.supportsRange);
      item.supportsRange = probe.supportsRange;
    }
    if (item.state === "resolving") {
      item.state = prev === "confirming" ? "confirming" : "queued";
    }
    this.persist();
    this.emitUpdate();
    if (item.state === "queued" && !this.deferredStart.has(item.id)) this.schedulePump();
  }
  rangeSupport = /* @__PURE__ */ new Map();
  /** Yalnızca bu oturum için ek HTTP başlıkları (ör. eklentiden gelen çerez) */
  extraHeaders = /* @__PURE__ */ new Map();
  /** "Daha sonra indir" seçilen kayıtlar: çözümleme bitince kendiliğinden başlamaz. */
  deferredStart = /* @__PURE__ */ new Set();
  holdRange(item, supportsRange) {
    this.rangeSupport.set(item.id, supportsRange);
  }
  getRangeSupport(item) {
    return this.rangeSupport.get(item.id) ?? true;
  }
  /**
   * Onay penceresinden gelen karar.
   */
  async confirm(id, savePath, start = true) {
    const item = this.must(id);
    if (start) this.deferredStart.delete(id);
    else this.deferredStart.add(id);
    if (savePath && savePath !== item.savePath) {
      item.savePath = savePath;
      item.name = basename(savePath);
    }
    const settings = this.store.getSettings();
    item.state = "queued";
    this.persist();
    this.emitUpdate();
    if (start && settings.general.autoStart) this.schedulePump();
    return item;
  }
  start(id) {
    const item = this.must(id);
    this.deferredStart.delete(id);
    if (item.state === "completed" || item.state === "downloading") return;
    if (item.state === "error") {
      item.errorMessage = void 0;
      item.progress.downloadedBytes = 0;
      item.progress.percent = 0;
    }
    item.state = "queued";
    delete item.scheduledAt;
    this.persist();
    this.emitUpdate();
    this.schedulePump();
  }
  /**
   * İndirmeyi kuyruğa alır: çalışan bir işi duraklatır, diğer durumlarda
   * durumu 'queued' yapar ve hemen başlatmaz — pompa (autoStart açıkken)
   * kuyruktan alır. Sağ tık menüsündeki "Kuyruğa ekle" için.
   */
  queue(id) {
    const item = this.must(id);
    if (item.state === "completed" || item.state === "confirming") return item;
    if (item.state === "downloading" || item.state === "resolving") {
      this.pause(id);
      const p = this.must(id);
      p.state = "queued";
      this.persist();
      this.emitUpdate();
      return p;
    }
    if (item.state === "scheduled") {
      item.state = "queued";
      delete item.scheduledAt;
    }
    if (item.state === "error" || item.state === "canceled") {
      item.errorMessage = void 0;
    }
    item.state = "queued";
    this.persist();
    this.emitUpdate();
    if (this.store.getSettings().general.autoStart) this.schedulePump();
    return item;
  }
  pause(id) {
    const item = this.must(id);
    const job = this.jobs.get(id);
    if (job) {
      const snap = job.pause();
      this.pausedSnapshots.set(id, snap);
      this.jobs.delete(id);
      item.progress.speed = 0;
      item.progress.connections = 0;
      const doneBytes = snap.reduce((a, s) => a + s.received, 0);
      item.progress.downloadedBytes = doneBytes;
      if (item.progress.totalBytes > 0) {
        item.progress.percent = Math.min(1, doneBytes / item.progress.totalBytes);
      }
    }
    if (item.state === "downloading" || item.state === "queued" || item.state === "resolving") {
      item.state = "paused";
      this.persist();
      this.emitUpdate();
      this.schedulePump();
    }
  }
  resume(id) {
    this.start(id);
  }
  cancel(id) {
    const item = this.must(id);
    const job = this.jobs.get(id);
    if (job) {
      job.cancel();
      this.jobs.delete(id);
    }
    item.state = "canceled";
    item.progress.speed = 0;
    item.progress.connections = 0;
    this.deferredStart.delete(id);
    this.persist();
    this.emitUpdate();
    this.schedulePump();
  }
  remove(id, deleteFile) {
    const item = this.must(id);
    const job = this.jobs.get(id);
    if (job) {
      job.cancel();
      this.jobs.delete(id);
    }
    if (deleteFile) {
      try {
        if (existsSync(item.savePath)) unlinkSync(item.savePath);
      } catch {
      }
    }
    this.items = this.items.filter((i) => i.id !== id);
    this.pausedSnapshots.delete(id);
    this.deferredStart.delete(id);
    this.extraHeaders.delete(id);
    this.persist();
    this.emitUpdate();
    this.schedulePump();
  }
  schedule(id, at) {
    const item = this.must(id);
    if (at === null) {
      delete item.scheduledAt;
      if (item.state === "scheduled") item.state = "queued";
      this.schedulePump();
    } else {
      item.scheduledAt = at;
      item.state = "scheduled";
      const job = this.jobs.get(id);
      if (job) {
        this.pausedSnapshots.set(id, job.pause());
        this.jobs.delete(id);
        item.progress.speed = 0;
      }
    }
    this.persist();
    this.emitUpdate();
    return item;
  }
  /** Saatlik zamanlayıcı, "scheduled" durumdakileri sıraya alır. */
  checkSchedules() {
    const now = Date.now();
    let changed = false;
    for (const item of this.items) {
      if (item.state === "scheduled" && item.scheduledAt && item.scheduledAt <= now) {
        delete item.scheduledAt;
        item.state = "queued";
        changed = true;
      }
    }
    if (changed) {
      this.persist();
      this.emitUpdate();
      this.schedulePump();
    }
  }
  clearCompleted() {
    const keep = this.items.filter((i) => i.state !== "completed");
    if (keep.length !== this.items.length) {
      this.items = keep;
      this.persist();
      this.emitUpdate();
    }
  }
  /** Eklenti/bildirim için hız özeti */
  summary() {
    let speed = 0;
    let active = 0;
    let queued = 0;
    for (const i of this.items) {
      if (i.state === "downloading") {
        active++;
        speed += i.progress.speed;
      } else if (i.state === "queued" || i.state === "resolving") queued++;
    }
    return { active, totalSpeed: speed, queued };
  }
  must(id) {
    const item = this.get(id);
    if (!item) throw new Error("indirme bulunamad\u0131: " + id);
    return item;
  }
  /* ------------------------------------------------------------------ */
  /* Harici işler (yt-dlp medya, torrent) için dış kapılar              */
  /* ------------------------------------------------------------------ */
  /** Harici işçinin ilerleme yayması için. */
  externalProgress(id, patch) {
    const item = this.get(id);
    if (!item) return;
    const { statusLine, ...rest } = patch;
    Object.assign(item.progress, rest);
    if (rest.totalBytes && rest.downloadedBytes !== void 0) {
      item.progress.percent = Math.min(1, rest.downloadedBytes / rest.totalBytes);
    }
    if (statusLine && item.media) item.media.statusLine = statusLine;
    const now = Date.now();
    const last = this.progressThrottle.get(id) || 0;
    if (now - last > 350) {
      this.progressThrottle.set(id, now);
      this.emit("progress", item);
    }
  }
  /** Harici işin başladığını bildirir (state='downloading' + startedAt). */
  externalStarted(id) {
    const item = this.get(id);
    if (!item) return;
    item.state = "downloading";
    item.startedAt = item.startedAt ?? Date.now();
    this.persist();
    this.emitUpdate();
  }
  externalState(id, state, errorMessage) {
    const item = this.get(id);
    if (!item) return;
    item.state = state;
    if (errorMessage !== void 0) item.errorMessage = errorMessage;
    this.persist();
    this.emitUpdate();
  }
  externalComplete(id, finalPath) {
    const item = this.get(id);
    if (!item) return;
    item.state = "completed";
    item.finishedAt = Date.now();
    item.progress.percent = 1;
    item.progress.speed = 0;
    item.progress.connections = 0;
    if (finalPath) {
      item.savePath = finalPath;
      item.name = basename(finalPath);
    }
    try {
      const size = statSync(item.savePath).size;
      item.progress.totalBytes = size;
      item.progress.downloadedBytes = size;
    } catch {
    }
    this.persist();
    this.emitUpdate();
    this.emit("completed", item);
  }
  externalError(id, message) {
    const item = this.get(id);
    if (!item) return;
    item.state = "error";
    item.errorMessage = message;
    item.progress.speed = 0;
    item.progress.connections = 0;
    this.persist();
    this.emitUpdate();
    this.emitError(item);
  }
  /** Yeni kayıt oluşturmadan mevcut kaydı güncelle (medya formatı seçimi vb.) */
  patchItem(id, patch) {
    const item = this.get(id);
    if (!item) return void 0;
    Object.assign(item, patch);
    this.persist();
    this.emitUpdate();
    return item;
  }
  /** Kuyruktaki slot kadar işi başlatır. */
  schedulePump() {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      this.pump();
    });
  }
  pump() {
    const settings = this.store.getSettings();
    const limit = Math.max(1, settings.general.maxConcurrent);
    const active = [...this.jobs.keys()];
    if (active.length >= limit) return;
    const candidates = this.items.filter(
      (i) => i.state === "queued" && i.kind !== "media" && !this.deferredStart.has(i.id)
    ).sort((a, b) => a.createdAt - b.createdAt);
    for (const item of candidates) {
      if (this.jobs.size >= limit) break;
      void this.launch(item, settings.general.segmentsPerDownload, settings.general.speedLimitMbps);
    }
  }
  async launch(item, segments, speedLimitMbps) {
    if (this.jobs.has(item.id)) return;
    if (item.progress.totalBytes > 0 && item.progress.downloadedBytes >= item.progress.totalBytes) {
      try {
        const st = statSync(item.savePath);
        if (st.size === item.progress.totalBytes) {
          item.state = "completed";
          item.progress.percent = 1;
          item.progress.downloadedBytes = st.size;
          item.progress.speed = 0;
          this.persist();
          this.emitUpdate();
          this.schedulePump();
          return;
        }
      } catch {
      }
    }
    item.state = "downloading";
    item.startedAt = item.startedAt ?? Date.now();
    item.progress.speed = 0;
    item.progress.connections = 0;
    this.emitUpdate();
    let totalBytes = item.progress.totalBytes;
    let supportsRange = this.getRangeSupport(item);
    if (!totalBytes) {
      const probe = await probeUrl(item.url, { pageUrl: item.pageUrl });
      if (this.get(item.id) !== item) return;
      if (probe.ok) {
        totalBytes = probe.sizeBytes ?? 0;
        supportsRange = probe.supportsRange;
        item.progress.totalBytes = totalBytes;
        this.rangeSupport.set(item.id, supportsRange);
        item.supportsRange = supportsRange;
        if (probe.name && (!item.name || item.name === "download")) {
          item.name = probe.name;
        }
        this.persist();
        this.emitUpdate();
      } else {
        item.state = "error";
        item.errorMessage = probe.error;
        this.emitError(item);
        this.schedulePump();
        return;
      }
    }
    const snapshot = this.pausedSnapshots.get(item.id);
    this.pausedSnapshots.delete(item.id);
    const job = new SegmentedJob(
      {
        url: item.url,
        savePath: item.savePath,
        totalBytes,
        supportsRange,
        segments: Math.max(1, segments),
        pageUrl: item.pageUrl,
        headers: this.extraHeaders.get(item.id),
        speedLimitBps: speedLimitMbps > 0 ? speedLimitMbps * 1024 * 1024 : 0
      },
      {
        onProgress: ({ downloadedBytes, totalBytes: tb, speed, connections }) => {
          if (this.get(item.id) !== item) return;
          this.applyProgress(item, downloadedBytes, totalBytes || tb, speed, connections);
        },
        onDone: () => {
          if (this.get(item.id) !== item) return;
          this.jobs.delete(item.id);
          this.onJobDone(item);
        },
        onError: (err) => {
          if (this.get(item.id) !== item) return;
          this.jobs.delete(item.id);
          if (item.state === "downloading") {
            item.state = "error";
            item.errorMessage = err.message;
            item.progress.speed = 0;
            item.progress.connections = 0;
            this.persist();
            this.emitUpdate();
            this.emitError(item);
          }
          this.schedulePump();
        }
      }
    );
    this.jobs.set(item.id, job);
    try {
      await job.start(snapshot);
    } catch (e) {
      this.jobs.delete(item.id);
      item.state = "error";
      item.errorMessage = e?.message || t("err.generic");
      item.progress.speed = 0;
      this.persist();
      this.emitUpdate();
      this.emitError(item);
      this.schedulePump();
    }
  }
  progressThrottle = /* @__PURE__ */ new Map();
  applyProgress(item, downloaded, total, speed, connections) {
    item.progress.downloadedBytes = downloaded;
    item.progress.totalBytes = total;
    item.progress.speed = speed;
    item.progress.connections = connections;
    if (total > 0) {
      item.progress.percent = Math.min(1, downloaded / total);
      item.progress.etaSeconds = speed > 0 ? (total - downloaded) / speed : null;
    } else {
      item.progress.percent = 0;
      item.progress.etaSeconds = null;
    }
    const now = Date.now();
    const last = this.progressThrottle.get(item.id) || 0;
    if (now - last > 350) {
      this.progressThrottle.set(item.id, now);
      this.emit("progress", item);
    }
  }
  onJobDone(item) {
    item.state = "completed";
    item.finishedAt = Date.now();
    item.progress.percent = 1;
    item.progress.speed = 0;
    item.progress.connections = 0;
    if (item.progress.totalBytes === 0) {
      try {
        item.progress.totalBytes = statSync(item.savePath).size;
        item.progress.downloadedBytes = item.progress.totalBytes;
      } catch {
      }
    }
    this.persist();
    this.emitUpdate();
    this.emit("completed", item);
    this.schedulePump();
  }
  emitUpdate() {
    this.emit("downloads", this.items);
  }
  emitError(item) {
    this.emit("download-error", item);
  }
  /** Kaldırılan dosyayı diske yaz (anlık kapanışlar için) */
  persistNow() {
    this.store.saveDownloadsNow(this.items);
  }
  persist() {
    this.store.saveDownloads(this.items);
  }
  /** Devam eden iş sayısını döndür (test/günlük için) */
  activeCount() {
    return this.jobs.size;
  }
};
function makeId() {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function uniquePath(p) {
  if (!existsSync(p)) return p;
  const dir = dirname2(p);
  const base = basename(p);
  const ext = extname(p);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; i < 1e3; i++) {
    const candidate = join2(dir, `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join2(dir, `${stem} (${Date.now()})${ext}`);
}
function startScheduler(manager) {
  const timer = setInterval(() => manager.checkSchedules(), 1e3);
  return () => clearInterval(timer);
}
export {
  DownloadManager,
  categoryForFilename,
  startScheduler,
  uniquePath
};
