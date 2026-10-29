// src/main/ytdlp.ts
import { spawn, execFile, execSync } from "child_process";
import { EventEmitter } from "events";
import { existsSync, promises as fsp } from "fs";
import { join, delimiter } from "path";
import { homedir } from "os";

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

// src/main/ytdlp.ts
function cookiesBrowser() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const open = (userData) => existsSync(join(userData, "lockfile"));
  if (process.platform === "win32") {
    const edge = join(local, "Microsoft", "Edge", "User Data");
    if (existsSync(edge)) return open(edge) ? void 0 : "edge";
    const chrome = join(local, "Google", "Chrome", "User Data");
    if (existsSync(chrome)) return open(chrome) ? void 0 : "chrome";
    const brave = join(local, "BraveSoftware", "Brave-Browser", "User Data");
    if (existsSync(brave)) return open(brave) ? void 0 : "brave";
    if (existsSync(join(local, "Mozilla", "Firefox", "Profiles"))) return "firefox";
  } else if (process.platform === "darwin") {
    if (existsSync(join(home, "Library", "Application Support", "Microsoft Edge"))) return "edge";
    if (existsSync(join(home, "Library", "Application Support", "Google", "Chrome"))) return "chrome";
    if (existsSync(join(home, "Library", "Application Support", "Firefox"))) return "firefox";
  } else {
    if (existsSync(join(home, ".config", "microsoft-edge"))) return "edge";
    if (existsSync(join(home, ".config", "google-chrome"))) return "chrome";
    if (existsSync(join(home, ".mozilla", "firefox"))) return "firefox";
  }
  return void 0;
}
var BASE_ARGS = [
  "--no-warnings",
  "--no-playlist",
  "--newline",
  "--progress",
  // Windows'ta yt-dlp boruya sistem kod sayfasıyla (ör. cp1254) yazıyor;
  // UTF-8 zorlanmazsa Türkçe dosya adları bozulur ve yol eşleşmez.
  "--encoding",
  "utf-8"
];
var OUTPUT_PATH_PATTERNS = [
  /\[Merger\] Merging formats into "(.+)"\s*$/,
  /\[ExtractAudio\] Destination:\s*(.+)$/,
  /\[ffmpeg\] Destination:\s*(.+)$/,
  /\[FixupM3u8\] Fixing MPEG-TS in MP4 container of "(.+)"\s*$/,
  /\[download\] Destination:\s*(.+)$/,
  /\[download\]\s+(.+?) has already been downloaded/
];
function pickExistingOutput(paths, fallback = "") {
  for (let i = paths.length - 1; i >= 0; i--) {
    if (paths[i] && existsSync(paths[i])) return paths[i];
  }
  return paths[paths.length - 1] || fallback;
}
var ToolLocator = class extends EventEmitter {
  settings;
  ytdlpCache;
  ffmpegCache;
  constructor(settings) {
    super();
    this.settings = settings;
  }
  updateSettings(settings) {
    this.settings = settings;
    this.ytdlpCache = void 0;
    this.ffmpegCache = void 0;
  }
  /** PATH + bilinen kurulum konumlarında yt-dlp arar. */
  findYtdlp() {
    if (this.ytdlpCache !== void 0) return this.ytdlpCache;
    this.ytdlpCache = this.locate(
      this.settings.social.ytdlpPath,
      ["yt-dlp.exe", "yt-dlp", "youtube-dl.exe", "youtube-dl"],
      ["yt-dlp", "youtube-dl"]
    );
    return this.ytdlpCache;
  }
  findFfmpeg() {
    if (this.ffmpegCache !== void 0) return this.ffmpegCache;
    this.ffmpegCache = this.locate(this.settings.social.ffmpegPath, ["ffmpeg.exe", "ffmpeg"], ["ffmpeg"]);
    return this.ffmpegCache;
  }
  locate(configured, files, commands) {
    if (configured && existsSync(configured)) return configured;
    const dirs = [
      join(appResourcesDir(), "bin"),
      join(process.cwd(), "bin"),
      join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links"),
      join(homedir(), "AppData", "Local", "Microsoft", "WindowsApps"),
      join(homedir(), "scoop", "shims"),
      "C:\\ProgramData\\chocolatey\\bin"
    ];
    const pathDirs = (process.env.PATH || "").split(delimiter);
    for (const d of [...pathDirs, ...dirs]) {
      if (!d) continue;
      for (const f of files) {
        try {
          const p = join(d, f);
          if (existsSync(p)) return p;
        } catch {
        }
      }
    }
    for (const cmd of commands) {
      try {
        const which = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
        const out = execSync(which, { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\r?\n/)[0].trim();
        if (out && existsSync(out)) return out;
      } catch {
      }
    }
    return null;
  }
  /** yt-dlp yoksa indirme yolunu gösteren hata üret */
  missingYtdlpError() {
    return new Error(
      `yt-dlp bulunamad\u0131 \u2014 Ayarlar \u2192 Sosyal medya b\xF6l\xFCm\xFCnden indirebilirsiniz (${this.settings.social.ytdlpPath || "PATH"})`
    );
  }
  missingFfmpegError() {
    return new Error(`ffmpeg bulunamad\u0131 \u2014 Ayarlar \u2192 Sosyal medya b\xF6l\xFCm\xFCnden belirtin`);
  }
};
function appResourcesDir() {
  if (process.resourcesPath && existsSync(process.resourcesPath)) {
    return process.resourcesPath;
  }
  return join(process.cwd(), "resources");
}
async function writeCookieFile(cookies, tmpDir) {
  const lines = ["# Netscape HTTP Cookie File", "# Generated by IDMS2", ""];
  for (const c of cookies) {
    const domain = c.domain || "";
    const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const httpOnly = c.httpOnly ? "TRUE" : "FALSE";
    const expiry = Math.floor(c.expirationDate || Math.floor(Date.now() / 1e3) + 86400 * 30);
    const path = c.path || "/";
    if (!c.name || c.value === void 0) continue;
    lines.push([domain, includeSub, path, secure, expiry, c.name, c.value].join("	"));
  }
  const file = join(tmpDir, `cookies_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.writeFile(file, lines.join("\n"), "utf8");
  return file;
}
var YtdlpRunner = class extends EventEmitter {
  locator;
  tmpDir;
  constructor(locator, tmpDir) {
    super();
    this.locator = locator;
    this.tmpDir = tmpDir;
  }
  async buildEnv() {
    const env = { ...process.env };
    const ff = this.locator.findFfmpeg();
    if (ff) {
      const dir = ff.replace(/[\\/][^\\/]+$/, "");
      env.PATH = `${dir}${delimiter}${env.PATH || ""}`;
    }
    return env;
  }
  async baseArgs(extra, cookieFile, ffmpegPath, cookiesFromBrowser) {
    const args = [...BASE_ARGS];
    const ff = ffmpegPath || this.locator.findFfmpeg();
    if (ff) args.push("--ffmpeg-location", ff);
    if (cookieFile) args.push("--cookies", cookieFile);
    else if (cookiesFromBrowser) args.push("--cookies-from-browser", cookiesFromBrowser);
    if (this.locator.findYtdlp()?.toLowerCase().includes("youtube-dl")) {
      return [...extra];
    }
    return [...args, ...extra];
  }
  /** Biçim listesini (indirmeden önce seçim için) çeker. */
  async probe(opts) {
    const bin = this.locator.findYtdlp();
    if (!bin) throw this.locator.missingYtdlpError();
    let cookieFile;
    let browser;
    if (opts.useCookies) {
      if (opts.cookies && opts.cookies.length > 0) {
        cookieFile = await writeCookieFile(opts.cookies, this.tmpDir);
      } else {
        browser = cookiesBrowser();
      }
    }
    const extra = ["-J", opts.url];
    if (opts.impersonate) {
      extra.splice(0, 0, "--no-check-certificate");
    }
    const args = await this.baseArgs(extra, cookieFile, void 0, browser);
    try {
      const stdout = await this.runRaw(bin, args, 9e4);
      const info = JSON.parse(stdout);
      const result = normalizeProbe(info, opts.url);
      const urls = /* @__PURE__ */ new Map();
      for (const f of Array.isArray(info.formats) ? info.formats : []) {
        if (f?.format_id && typeof f.url === "string") urls.set(String(f.format_id), f.url);
      }
      try {
        await fillMissingFormatSizes(result.formats, urls, result.pageUrl || opts.url);
      } catch {
      }
      return result;
    } catch (e) {
      return {
        ok: false,
        pageUrl: opts.url,
        title: "",
        extractor: "",
        formats: [],
        error: e?.message || "yt-dlp hatas\u0131"
      };
    } finally {
      if (cookieFile) fsp.unlink(cookieFile).catch(() => void 0);
    }
  }
  /** Gerçek indirme; ilerleme satırları olay olarak yayınlanır. */
  async download(opts, cb = {}, signal) {
    const bin = this.locator.findYtdlp();
    if (!bin) throw this.locator.missingYtdlpError();
    await fsp.mkdir(opts.saveDir, { recursive: true });
    let cookieFile;
    let browser;
    if (opts.useCookies) {
      if (opts.cookies && opts.cookies.length > 0) {
        cookieFile = await writeCookieFile(opts.cookies, this.tmpDir);
      } else {
        browser = cookiesBrowser();
      }
    }
    const quality = opts.quality || "best";
    const ffmpeg = opts.ffmpegPath || this.locator.findFfmpeg();
    const extra = ["-o", join(opts.saveDir, opts.filenameTemplate || "%(title)s.%(ext)s")];
    if (quality === "audio") {
      if (opts.formatId) {
        extra.push("-f", opts.formatId);
      } else {
        extra.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
      }
    } else if (opts.formatId) {
      extra.push("-f", `${opts.formatId}+bestaudio/best`);
    } else {
      extra.push("-f", "bestvideo*+bestaudio/best");
    }
    if (quality !== "audio" && ffmpeg) extra.push("--downloader", "m3u8:ffmpeg");
    if (opts.forceOverwrite) extra.push("--force-overwrites");
    if (opts.pageUrl) extra.push("--referer", opts.pageUrl);
    if (opts.impersonate) extra.push("--no-check-certificate");
    const args = await this.baseArgs(extra, cookieFile, opts.ffmpegPath, browser);
    args.push(opts.url);
    const env = await this.buildEnv();
    const lines = [];
    const outputPaths = [];
    let streamBytes = null;
    await this.runStream(bin, args, {
      signal,
      env,
      onLine: (line) => {
        lines.push(line);
        cb.onOutput?.(line);
        const sizeMatch = /\[download\].*?\bof\s+~?\s*([\d.]+)\s*([KMG])i?B/.exec(line);
        if (sizeMatch) {
          const parsed = parseSize(sizeMatch[1], sizeMatch[2]);
          if (parsed > 0) streamBytes = parsed;
        }
        const dlMatch = /\[download\]\s+([\d.]+)%/.exec(line);
        if (dlMatch) {
          const percent = parseFloat(dlMatch[1]) / 100;
          const speedMatch = /at\s+([\d.]+[KMG]?i?B\/s)/.exec(line);
          const etaMatch = /ETA\s+(\d+:\d+(?::\d+)?)/.exec(line);
          cb.onProgress?.({
            percent: isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0,
            speed: speedMatch ? parseSpeed(speedMatch[1]) : 0,
            etaSeconds: etaMatch ? parseEta(etaMatch[1]) : null,
            totalBytes: streamBytes,
            statusLine: line.replace(/^\[download\]\s+/, "").trim()
          });
        } else if (line.startsWith("[Merger]") || line.startsWith("[ffmpeg]")) {
          cb.onProgress?.({
            percent: 0.98,
            speed: 0,
            etaSeconds: null,
            totalBytes: streamBytes,
            statusLine: line
          });
        } else if (line.startsWith("[ExtractAudio]")) {
          cb.onProgress?.({
            percent: 0.99,
            speed: 0,
            etaSeconds: null,
            totalBytes: streamBytes,
            statusLine: line
          });
        }
        for (const re of OUTPUT_PATH_PATTERNS) {
          const m = re.exec(line);
          if (m) {
            outputPaths.push(m[1].trim());
            break;
          }
        }
      }
    });
    if (cookieFile) fsp.unlink(cookieFile).catch(() => void 0);
    const filePath = pickExistingOutput(outputPaths, opts.saveDir);
    return { filePath, rawLines: lines };
  }
  /** yt-dlp sürümünü (hakkında/kurulum kontrolü için) */
  async version() {
    const bin = this.locator.findYtdlp();
    if (!bin) return null;
    try {
      const out = await this.runRaw(bin, ["--version"], 1e4);
      return out.trim();
    } catch {
      return null;
    }
  }
  runRaw(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr?.slice(-500) || err.message));
          else resolve(stdout);
        }
      );
    });
  }
  runStream(bin, args, handlers) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        windowsHide: true,
        env: handlers.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const kill = () => {
        try {
          child.kill();
        } catch {
        }
      };
      handlers.signal?.addEventListener("abort", kill, { once: true });
      let lastErrorLine = "";
      const emit = (line) => {
        if (line.startsWith("ERROR:")) lastErrorLine = line.slice(6).trim();
        handlers.onLine(line);
      };
      let buffer = "";
      const consume = (data) => {
        buffer += data.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line.trim()) emit(line);
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.on("error", (err) => reject(err));
      child.on("close", (code, signal) => {
        if (buffer.trim()) emit(buffer.trim());
        if (signal || handlers.signal?.aborted) {
          reject(new Error("\u0130ndirme iptal edildi"));
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              lastErrorLine ? `yt-dlp: ${lastErrorLine.slice(0, 300)}` : `yt-dlp \xE7\u0131k\u0131\u015F kodu ${code}`
            )
          );
        }
      });
    });
  }
};
function normalizeProbe(info, pageUrl) {
  const formats = [];
  const raw = Array.isArray(info.formats) ? info.formats : [];
  for (const f of raw) {
    if (!f || !f.format_id) continue;
    const vcodec = f.vcodec && f.vcodec !== "none" ? f.vcodec : null;
    const acodec = f.acodec && f.acodec !== "none" ? f.acodec : null;
    const isAudioOnly = !vcodec && !!acodec;
    const protocol = String(f.protocol || "");
    const hls = /m3u8/i.test(protocol);
    if (f.ext === "mhtml" || f.ext === "m3u8_native") continue;
    const resolution = f.resolution && f.resolution !== "audio only" ? f.resolution : f.height ? `${f.width || "?"}x${f.height}` : null;
    formats.push({
      formatId: String(f.format_id),
      ext: f.ext || "mp4",
      resolution,
      fps: f.fps ?? null,
      vcodec,
      acodec,
      tbr: f.tbr ?? null,
      sizeBytes: f.filesize ?? f.filesize_approx ?? null,
      note: [f.format_note, f.protocol].filter(Boolean).join(" \xB7 "),
      isAudioOnly,
      protocol,
      hls
    });
  }
  formats.sort((a, b) => {
    if (a.isAudioOnly !== b.isAudioOnly) return a.isAudioOnly ? 1 : -1;
    if (!!a.hls !== !!b.hls) return a.hls ? 1 : -1;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  return {
    ok: true,
    pageUrl: info.original_url || info.webpage_url || pageUrl,
    title: info.title || info.fulltitle || "",
    extractor: info.extractor_key || info.extractor || "",
    thumbnail: info.thumbnail || void 0,
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
    formats
  };
}
async function fillMissingFormatSizes(formats, urls, pageUrl) {
  const targets = formats.filter(
    (f) => !f.hls && !(typeof f.sizeBytes === "number" && f.sizeBytes > 0) && urls.has(f.formatId)
  );
  if (targets.length === 0) return;
  const deadline = Date.now() + 3e3;
  const queue = [...targets];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      try {
        const probe = await probeUrl(urls.get(row.formatId), {
          pageUrl,
          timeoutMs: Math.min(2e3, left)
        });
        if (probe.ok && typeof probe.sizeBytes === "number" && probe.sizeBytes > 0) {
          row.sizeBytes = probe.sizeBytes;
        }
      } catch {
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
}
function parseSpeed(s) {
  const m = /^([\d.]+)([KMG]i?)?B\/s$/i.exec(s);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  const mult = unit.startsWith("K") ? 1024 : unit.startsWith("M") ? 1024 ** 2 : unit.startsWith("G") ? 1024 ** 3 : 1;
  return Math.round(v * mult);
}
function parseSize(value, unit) {
  const v = parseFloat(value);
  if (!isFinite(v)) return 0;
  const u = unit.toUpperCase();
  const mult = u === "K" ? 1024 : u === "M" ? 1024 ** 2 : u === "G" ? 1024 ** 3 : 1;
  return Math.round(v * mult);
}
function parseEta(s) {
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => !isFinite(p))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}
var SUPPORTED_SITES = [
  "YouTube",
  "Instagram",
  "Facebook",
  "Reddit",
  "TikTok",
  "X / Twitter",
  "Vimeo",
  "Twitch",
  "Kick",
  "Dailymotion",
  "SoundCloud",
  "Pinterest",
  "VK",
  "Bilibili",
  "+1000 site"
];
export {
  SUPPORTED_SITES,
  ToolLocator,
  YtdlpRunner,
  pickExistingOutput,
  writeCookieFile
};
