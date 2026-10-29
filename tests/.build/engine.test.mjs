// tests/engine.test.ts
import { createServer, request } from "http";
import { createHash, randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { readFileSync, existsSync as existsSync2, rmSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

// src/main/ytdlp.ts
import { existsSync, promises as fsp } from "fs";
function pickExistingOutput(paths, fallback = "") {
  for (let i = paths.length - 1; i >= 0; i--) {
    if (paths[i] && existsSync(paths[i])) return paths[i];
  }
  return paths[paths.length - 1] || fallback;
}

// tests/engine.test.ts
var __dirname = dirname(fileURLToPath(import.meta.url));
var root = (() => {
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync2(join(d, "package.json"))) return d;
    d = dirname(d);
  }
  return process.cwd();
})();
var mod = (p) => pathToFileURL(p).href;
var passed = 0;
var failed = 0;
var failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` \u2014 ${detail}` : ""));
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}
function section(t) {
  console.log(`
\u25A0 ${t}`);
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(port, method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.body === void 0 ? null : Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...opts.headers || {},
          ...payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, json, text });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
var FILES = {
  "/big.bin": randomBytes(6 * 1024 * 1024),
  // 6 MB → 8 segment
  "/medium.bin": randomBytes(1536 * 1024),
  // 1.5 MB
  "/video.mp4": randomBytes(3 * 1024 * 1024),
  // video uzantısı → kategori testi
  "/master.m3u8": Buffer.from(
    [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
      "low.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      "high.m3u8"
    ].join("\n")
  ),
  "/small.txt": Buffer.from("hello idms2")
};
var requestLog = [];
var server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const body = FILES[url.pathname];
  requestLog.push({ method: req.method, path: url.pathname, range: req.headers.range });
  if (!body) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const size = body.length;
  if (req.method === "HEAD") {
    res.writeHead(200, {
      "Content-Length": size,
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes"
    });
    res.end();
    return;
  }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream"
      });
      res.end(slice);
      return;
    }
  }
  res.writeHead(200, {
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream"
  });
  res.end(body);
});
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function sha256File(path) {
  return sha256(readFileSync(path));
}
function makeSettings(over = {}) {
  return {
    general: {
      language: "tr",
      theme: "system",
      downloadDir: "",
      maxConcurrent: 3,
      segmentsPerDownload: 8,
      speedLimitMbps: 0,
      autoStart: true,
      confirmBeforeDownload: false,
      monitorClipboard: false,
      startOnBoot: false,
      startMinimized: false,
      ...over.general
    },
    notifications: {
      onStart: true,
      onProgress: true,
      onComplete: true,
      onError: true,
      systemToasts: false,
      inAppToasts: true,
      playSound: false
    },
    social: {
      ytdlpPath: "",
      ffmpegPath: "",
      passCookies: true,
      preferredQuality: "best",
      impersonate: true
    },
    torrent: {
      saveDir: "",
      port: 0,
      maxConcurrent: 3,
      uploadLimitMbps: 0,
      seedRatioLimit: 2,
      dht: true,
      utp: true
    },
    extension: {
      port: 19789,
      pairingCode: "TEST01",
      token: "engine-test-token-0123456789abcdef0123456789abcdef",
      allowedOrigins: [],
      enabled: true,
      floatingPanel: true
    },
    ...over
  };
}
var FakeStore = class {
  constructor(settings) {
    this.settings = settings;
    this.downloads = [];
    this.saveCount = 0;
  }
  getSettings() {
    return this.settings;
  }
  patchSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      general: { ...this.settings.general, ...patch.general || {} },
      extension: { ...this.settings.extension, ...patch.extension || {} }
    };
    return this.settings;
  }
  saveSettings() {
  }
  loadDownloads() {
    return this.downloads;
  }
  saveDownloads(items) {
    this.downloads = items;
    this.saveCount++;
  }
  saveDownloadsNow(items) {
    this.downloads = items;
    this.saveCount++;
  }
};
async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const outDir = join(tmpdir(), "idms2-engine-tests");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const { probeUrl: probeUrl2, filenameFromDisposition, filenameFromUrl, sanitizeFilename } = await import(mod(join(root, "tests", ".build", "probe.mjs")));
  const { DownloadManager, categoryForFilename, uniquePath } = await import(mod(join(root, "tests", ".build", "manager.mjs")));
  const { ExtensionServer } = await import(mod(join(root, "tests", ".build", "extServer.mjs")));
  section("1. URL sorgulama (probe)");
  const p1 = await probeUrl2(`${base}/big.bin`);
  ok("dosya ad\u0131 \xE7\u0131kar", p1.name === "big.bin", p1.name);
  ok("boyut do\u011Fru", p1.sizeBytes === FILES["/big.bin"].length, `${p1.sizeBytes}`);
  ok("Range destekli", p1.supportsRange === true);
  ok("ok=true", p1.ok === true);
  const p2 = await probeUrl2(`${base}/does-not-exist`);
  ok("404 yakalan\u0131r", p2.ok === false && /404/.test(p2.error || ""), p2.error);
  const p3 = await probeUrl2("not-a-url");
  ok("ge\xE7ersiz URL reddedilir", p3.ok === false);
  ok(
    "Content-Disposition ad\u0131",
    filenameFromDisposition('attachment; filename="dosya adi.zip"') === "dosya adi.zip"
  );
  ok(
    "filename* (UTF-8) \xE7\xF6z\xFCm\xFC",
    filenameFromDisposition("attachment; filename*=UTF-8''video%20g%C3%B6r%C3%BCnt%C3%BC.mp4") === "video g\xF6r\xFCnt\xFC.mp4"
  );
  ok("URL\u2019den ad", filenameFromUrl("https://x.com/a/b/film.mp4?dl=1") === "film.mp4");
  ok("ge\xE7ersiz karakter temizli\u011Fi", sanitizeFilename('a<b>c:d"e') === "a_b_c_d_e");
  ok("uzun ad k\u0131rp\u0131l\u0131r", sanitizeFilename("x".repeat(500) + ".bin").length <= 200);
  ok("kategori: video", categoryForFilename("film.mp4") === "video");
  ok("kategori: ar\u015Fiv", categoryForFilename("arsiv.7z") === "archive");
  ok("kategori: program", categoryForFilename("kur.exe") === "program");
  ok("kategori: bilinmeyen \u2192 other", categoryForFilename("veri.xyz") === "other");
  section("2. \xC7ok segmentli indirme (b\xFCt\xFCnl\xFCk)");
  const store = new FakeStore(makeSettings());
  store.getSettings().general.downloadDir = join(outDir, "downloads");
  const mgr = new DownloadManager(store);
  const target1 = join(outDir, "big.bin");
  const add1 = await mgr.add({ url: `${base}/big.bin`, savePath: target1, silent: true });
  ok("\xF6\u011Fe eklendi", !!add1.id);
  ok("durum queued/downloading", ["queued", "downloading", "resolving"].includes(add1.state), add1.state);
  let deadline = Date.now() + 3e4;
  while (Date.now() < deadline) {
    const it = mgr.get(add1.id);
    if (it && (it.state === "completed" || it.state === "error")) break;
    await sleep(120);
  }
  const done1 = mgr.get(add1.id);
  ok("tamamland\u0131", done1.state === "completed", `${done1.state} ${done1.errorMessage || ""}`);
  ok("dosya olu\u015Ftu", existsSync2(target1));
  if (existsSync2(target1)) {
    const got = sha256File(target1);
    const want = sha256(FILES["/big.bin"]);
    ok("SHA256 e\u015Fle\u015Fiyor (segment yaz\u0131m\u0131)", got === want, `${got.slice(0, 12)} != ${want.slice(0, 12)}`);
    ok("boyut tam", readFileSync(target1).length === FILES["/big.bin"].length);
  }
  const segReqs = requestLog.filter((r) => r.path === "/big.bin" && r.method === "GET");
  ok(
    "\xE7oklu ba\u011Flant\u0131 kullan\u0131ld\u0131 (>1 GET)",
    segReqs.length > 1,
    `${segReqs.length} GET`
  );
  ok(
    "Range ba\u015Fl\u0131klar\u0131 g\xF6nderildi",
    segReqs.every((r) => !!r.range),
    `${segReqs.filter((r) => r.range).length}/${segReqs.length}`
  );
  section("3. Otomatik ad ve kategori");
  const add2 = await mgr.add({ url: `${base}/video.mp4`, silent: true });
  await sleep(2500);
  const it2 = mgr.get(add2.id);
  ok("ad video.mp4", it2.name === "video.mp4", it2.name);
  ok("kategori video", it2.category === "video", it2.category);
  ok("kendi klas\xF6r\xFCne yaz\u0131ld\u0131", it2.savePath.includes("video"), it2.savePath);
  deadline = Date.now() + 2e4;
  while (Date.now() < deadline) {
    const it = mgr.get(add2.id);
    if (it && (it.state === "completed" || it.state === "error")) break;
    await sleep(120);
  }
  ok("video indirme tamam", mgr.get(add2.id).state === "completed", mgr.get(add2.id).state);
  section("4. \xC7ak\u0131\u015Fan yol benzersizle\u015Ftirilir");
  const p1path = uniquePath(target1);
  ok("var olan yol i\xE7in (1) eklenir", /\(1\)/.test(p1path), p1path);
  const p2path = uniquePath(join(outDir, "never.bin"));
  ok("olmayan yol aynen kal\u0131r", p2path === join(outDir, "never.bin"));
  section("5. Kuyruk e\u015Fzamanl\u0131l\u0131\u011F\u0131");
  const storeC = new FakeStore(makeSettings());
  storeC.getSettings().general.downloadDir = join(outDir, "dl2");
  storeC.getSettings().general.maxConcurrent = 2;
  const mgrC = new DownloadManager(storeC);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const it = await mgrC.add({ url: `${base}/medium.bin`, silent: true });
    ids.push(it.id);
  }
  await sleep(900);
  const active = ids.filter((id) => mgrC.get(id).state === "downloading").length;
  ok("e\u015Fzamanl\u0131 \u2264 2", active <= 2, `${active} aktif`);
  ok("kuyrukta bekleyen var", ids.some((id) => mgrC.get(id).state !== "downloading"));
  deadline = Date.now() + 4e4;
  while (Date.now() < deadline) {
    const states = ids.map((id) => mgrC.get(id).state);
    if (states.every((s) => s === "completed" || s === "error")) break;
    await sleep(200);
  }
  const finalStates = ids.map((id) => mgrC.get(id).state);
  ok(
    "hepsi tamamland\u0131",
    finalStates.every((s) => s === "completed"),
    JSON.stringify(finalStates)
  );
  section("6. Duraklat \u2192 devam (resume)");
  const storeR = new FakeStore(makeSettings());
  storeR.getSettings().general.downloadDir = join(outDir, "dl6");
  storeR.getSettings().general.speedLimitMbps = 2;
  const mgrR = new DownloadManager(storeR);
  const target3 = join(outDir, "resume.bin");
  const add3 = await mgrR.add({ url: `${base}/medium.bin`, savePath: target3, silent: true });
  await sleep(700);
  const mid = mgrR.get(add3.id);
  if (mid.state === "downloading") {
    mgrR.pause(add3.id);
    const paused = mgrR.get(add3.id);
    ok("duraklat\u0131ld\u0131", paused.state === "paused", paused.state);
    ok("h\u0131z s\u0131f\u0131rland\u0131", paused.progress.speed === 0);
    ok("ilerleme korundu", paused.progress.downloadedBytes > 0, `${paused.progress.downloadedBytes}`);
    const savedBytes = paused.progress.downloadedBytes;
    await sleep(400);
    mgrR.resume(add3.id);
    deadline = Date.now() + 4e4;
    while (Date.now() < deadline) {
      const it = mgrR.get(add3.id);
      if (it.state === "completed" || it.state === "error") break;
      await sleep(150);
    }
    const fin = mgrR.get(add3.id);
    ok("devam ettirip tamamlad\u0131", fin.state === "completed", `${fin.state} ${fin.errorMessage || ""}`);
    ok("duraklatma an\u0131nda ilerleme kaybolmad\u0131", fin.progress.downloadedBytes >= savedBytes);
    if (existsSync2(target3)) {
      ok(
        "resume sonras\u0131 SHA256",
        sha256File(target3) === sha256(FILES["/medium.bin"]),
        `${sha256File(target3).slice(0, 12)} != ${sha256(FILES["/medium.bin"]).slice(0, 12)}`
      );
    }
  } else {
    ok("duraklat testi (beklenen durum)", false, `state=${mid.state}`);
  }
  section("7. Kald\u0131rma");
  const add4 = await mgr.add({ url: `${base}/small.txt`, silent: true });
  await sleep(1500);
  const before = mgr.list().length;
  mgr.remove(add4.id, true);
  ok("\xF6\u011Fe listeden silindi", mgr.list().length === before - 1);
  section("8. Zamanlama");
  const add5 = await mgr.add({ url: `${base}/small.txt`, silent: true, savePath: join(outDir, "sch.txt") });
  mgr.schedule(add5.id, Date.now() + 60 * 60 * 1e3);
  ok("durum scheduled", mgr.get(add5.id).state === "scheduled");
  mgr.checkSchedules();
  ok("gelecek zaman sabit kal\u0131r", mgr.get(add5.id).state === "scheduled");
  mgr.schedule(add5.id, Date.now() - 1e3);
  mgr.checkSchedules();
  ok("ge\xE7mi\u015F zaman kuyru\u011Fa al\u0131n\u0131r", mgr.get(add5.id).state !== "scheduled", mgr.get(add5.id).state);
  deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    const it = mgr.get(add5.id);
    if (it.state === "completed" || it.state === "error") break;
    await sleep(150);
  }
  section("9. \u0130ndirmeden \xF6nce onay (confirmBeforeDownload)");
  const store9 = new FakeStore(makeSettings());
  store9.getSettings().general.downloadDir = join(outDir, "dl9");
  store9.getSettings().general.confirmBeforeDownload = true;
  store9.getSettings().general.autoStart = true;
  const mgr9 = new DownloadManager(store9);
  const add9 = await mgr9.add({ url: `${base}/small.txt`, silent: false });
  let waited = 0;
  while (waited < 5e3 && mgr9.get(add9.id).state !== "confirming") {
    await sleep(100);
    waited += 100;
  }
  ok("confirming durumunda bekler", mgr9.get(add9.id).state === "confirming", mgr9.get(add9.id).state);
  await sleep(800);
  ok("otomatik ba\u015Flamaz", mgr9.get(add9.id).state === "confirming");
  mgr9.confirm(add9.id, void 0, true);
  ok("onay sonras\u0131 queued", mgr9.get(add9.id).state !== "confirming", mgr9.get(add9.id).state);
  deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    const it = mgr9.get(add9.id);
    if (it.state === "completed" || it.state === "error") break;
    await sleep(150);
  }
  ok("onaydan sonra iner", mgr9.get(add9.id).state === "completed", mgr9.get(add9.id).state);
  section("10. Taray\u0131c\u0131 eklentisi k\xF6pr\xFCs\xFC (HTTP + WS)");
  const wsMod = await import(mod(join(root, "node_modules", "ws", "index.js")));
  const WebSocket = wsMod.WebSocket || wsMod.default?.WebSocket || wsMod.default;
  if (typeof WebSocket !== "function") throw new Error("ws mod\xFCl\xFC y\xFCklenemedi");
  const extStore = new FakeStore(makeSettings());
  extStore.getSettings().general.downloadDir = join(outDir, "dl10");
  const mgrExt = new DownloadManager(extStore);
  const floatCalls = [];
  const floatBridge = {
    enabled: true,
    language: "tr",
    async formats(media, key) {
      floatCalls.push({ type: "formats", media, key });
      return {
        ok: true,
        formats: [
          {
            formatId: "src:0",
            kind: "video",
            label: "720p",
            url: "https://cdn.example.com/v-720.mp4"
          }
        ],
        language: "tr"
      };
    },
    async download(media, kind, formatId, key) {
      floatCalls.push({ type: "download", media, kind, formatId, key });
      return { ok: true, message: "IDMS kuyru\u011Funa eklendi" };
    },
    openFormats(media) {
      floatCalls.push({ type: "openFormats", media });
    },
    showMainWindow() {
      floatCalls.push({ type: "showMainWindow" });
    }
  };
  const ext = new ExtensionServer(extStore, mgrExt, void 0, floatBridge);
  const started = await ext.start();
  ok("sunucu ba\u015Flad\u0131", started === true);
  ok("status.running", ext.status.running === true);
  ok("port atand\u0131", ext.status.port > 0, String(ext.status.port));
  const EXT_ORIGIN = "chrome-extension://idms-engine-test";
  const WEB_ORIGIN = "https://evil.example";
  const infoRes = await httpJson(ext.status.port, "GET", "/info", {
    headers: { Origin: EXT_ORIGIN }
  });
  ok(
    "HTTP /info eklenti k\xF6kenine a\xE7\u0131k",
    infoRes.status === 200 && infoRes.json?.app === "IDMS",
    `${infoRes.status}`
  );
  ok("HTTP /info protokol 2", infoRes.json?.protocol === 2);
  ok(
    "HTTP /info CORS eklenti k\xF6keni",
    infoRes.headers["access-control-allow-origin"] === EXT_ORIGIN
  );
  const preflightOk = await httpJson(ext.status.port, "OPTIONS", "/pair", {
    headers: { Origin: EXT_ORIGIN, "Access-Control-Request-Method": "POST" }
  });
  ok("OPTIONS eklenti k\xF6kenine 204", preflightOk.status === 204, String(preflightOk.status));
  const preflightBad = await httpJson(ext.status.port, "OPTIONS", "/pair", {
    headers: { Origin: WEB_ORIGIN, "Access-Control-Request-Method": "POST" }
  });
  ok("OPTIONS web k\xF6kenine 403", preflightBad.status === 403, String(preflightBad.status));
  ok("CORS web k\xF6kenine ACAO vermez", !preflightBad.headers["access-control-allow-origin"]);
  const pairWeb = await httpJson(ext.status.port, "POST", "/pair", {
    headers: { Origin: WEB_ORIGIN },
    body: { code: "TEST01" }
  });
  ok("web k\xF6keni e\u015Fle\u015Femez", pairWeb.status === 403, String(pairWeb.status));
  const pairWrong = await httpJson(ext.status.port, "POST", "/pair", {
    headers: { Origin: EXT_ORIGIN },
    body: { code: "WRONG1" }
  });
  ok("hatal\u0131 kod 401", pairWrong.status === 401, String(pairWrong.status));
  ok("hatal\u0131 kodda paired=false", ext.status.paired === false);
  const pairOk = await httpJson(ext.status.port, "POST", "/pair", {
    headers: { Origin: EXT_ORIGIN },
    body: { code: "TEST01", client: "EngineTest" }
  });
  const firstToken = String(pairOk.json?.token || "");
  ok("do\u011Fru kod token verir", pairOk.status === 200 && firstToken.length >= 32, `${pairOk.status}`);
  ok(
    "token yaln\u0131zca eklenti k\xF6kenine CORS",
    pairOk.headers["access-control-allow-origin"] === EXT_ORIGIN
  );
  ok(
    "e\u015Fle\u015Fen k\xF6ken kaydedildi",
    extStore.getSettings().extension.allowedOrigins.includes(EXT_ORIGIN)
  );
  ok("status.paired = true", ext.status.paired === true);
  const whoami = await httpJson(ext.status.port, "GET", "/whoami", {
    headers: { Origin: EXT_ORIGIN }
  });
  ok("whoami e\u015Fle\u015Fmi\u015F k\xF6keni bildirir", whoami.json?.paired === true && whoami.json?.knownExtension === true);
  const noToken = await httpJson(ext.status.port, "POST", "/rpc", {
    headers: { Origin: EXT_ORIGIN },
    body: { t: "ping" }
  });
  ok("tokensiz /rpc 401", noToken.status === 401, String(noToken.status));
  const badOrigin = await httpJson(ext.status.port, "POST", "/rpc", {
    headers: { Origin: WEB_ORIGIN, "X-IDMS-Token": firstToken },
    body: { t: "ping" }
  });
  ok("yetkisiz k\xF6ken tokenla bile 403", badOrigin.status === 403, String(badOrigin.status));
  const httpDl = await httpJson(ext.status.port, "POST", "/rpc", {
    headers: { Origin: EXT_ORIGIN, "X-IDMS-Token": firstToken },
    body: { t: "download", url: `${base}/small.txt`, name: "http-kucuk.txt" }
  });
  ok(
    "HTTP /rpc indirme kabul edildi",
    httpDl.status === 200 && httpDl.json?.ok === true,
    httpDl.text.slice(0, 120)
  );
  ok(
    "HTTP indirmesi y\xF6neticiye eklendi",
    mgrExt.list().some((i) => i.url.endsWith("/small.txt"))
  );
  const statusRes = await httpJson(ext.status.port, "GET", "/status", {
    headers: { Origin: EXT_ORIGIN, "X-IDMS-Token": firstToken }
  });
  ok(
    "HTTP /status \xF6zet d\xF6ner",
    statusRes.status === 200 && !!statusRes.json?.summary,
    String(statusRes.status)
  );
  const revoked = ext.revoke();
  ok(
    "revoke e\u015Fle\u015Ftirmeyi s\u0131f\u0131rlar",
    revoked.paired === false && extStore.getSettings().extension.allowedOrigins.length === 0
  );
  const oldToken = await httpJson(ext.status.port, "GET", "/status", {
    headers: { Origin: EXT_ORIGIN, "X-IDMS-Token": firstToken }
  });
  ok("eski token ge\xE7ersiz", oldToken.status === 401, String(oldToken.status));
  const pairAgain = await httpJson(ext.status.port, "POST", "/pair", {
    headers: { Origin: EXT_ORIGIN },
    body: { code: "TEST01" }
  });
  const token = String(pairAgain.json?.token || "");
  ok(
    "yeniden e\u015Fle\u015Fme yeni token verir",
    pairAgain.status === 200 && token.length >= 32 && token !== firstToken
  );
  const newToken = await httpJson(ext.status.port, "GET", "/status", {
    headers: { Origin: EXT_ORIGIN, "X-IDMS-Token": token }
  });
  ok(
    "yeni token \xE7al\u0131\u015F\u0131r",
    newToken.status === 200 && newToken.json?.paired === true,
    String(newToken.status)
  );
  const ws1 = new WebSocket(`ws://127.0.0.1:${ext.status.port}`);
  const msgs1 = [];
  await new Promise((res, rej) => {
    ws1.on("message", (d) => {
      msgs1.push(JSON.parse(d.toString()));
      if (msgs1.length >= 2) res();
    });
    ws1.on("error", rej);
    ws1.on(
      "open",
      () => ws1.send(JSON.stringify({ t: "hello", client: "TestBrowser", version: "9.9.9", pairingCode: "WRONG1" }))
    );
  });
  const welcome1 = msgs1.find((m) => m.t === "welcome");
  ok("welcome geldi", !!welcome1);
  ok("yanl\u0131\u015F kodda paired=false", welcome1 && welcome1.paired === false);
  ok("pairingCode g\xF6nderildi", welcome1 && welcome1.pairingCode === "TEST01");
  ws1.send(JSON.stringify({ t: "download", url: `${base}/small.txt` }));
  const reject = await new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "ack" && m.ok === false) {
        ws1.off("message", h);
        res(m);
      }
    };
    ws1.on("message", h);
  });
  ok("e\u015Fle\u015Ftirilmeden indirme reddedilir", /eşleştirme/.test(reject.message || ""), reject.message);
  ws1.close();
  await sleep(200);
  const ws2 = new WebSocket(`ws://127.0.0.1:${ext.status.port}`);
  const msgs2 = [];
  ws2.on("message", (d) => msgs2.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => {
    ws2.on(
      "open",
      () => ws2.send(JSON.stringify({ t: "hello", client: "Chrome", version: "131.0", pairingCode: "TEST01" }))
    );
    ws2.on("error", rej);
    const iv = setInterval(() => {
      if (msgs2.some((m) => m.t === "welcome" && m.paired)) {
        clearInterval(iv);
        res();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(iv);
      res();
    }, 3e3);
  });
  const welcome2 = msgs2.find((m) => m.t === "welcome" && m.paired);
  ok("do\u011Fru kodla paired=true", !!welcome2);
  ok("sunucu taraf\u0131nda paired say\u0131ld\u0131", ext.status.paired === true);
  ok("istemci listelendi", ext.status.clients.length === 1 && ext.status.clients[0].client === "Chrome");
  const wsFloat = new WebSocket(`ws://127.0.0.1:${ext.status.port}`, {
    origin: "chrome-extension://abcdefghijklmnop"
  });
  await new Promise((res, rej) => {
    wsFloat.on(
      "open",
      () => wsFloat.send(
        JSON.stringify({ t: "hello", client: "FloatBrowser", version: "1.2.0", pairingCode: "TEST01" })
      )
    );
    wsFloat.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "welcome" && m.paired === true) res();
    });
    wsFloat.on("error", rej);
    setTimeout(res, 2e3);
  });
  const floatMedia = {
    url: "https://cdn.example.com/v.mp4",
    pageUrl: "https://example.com/watch",
    title: "\xD6rnek video",
    pageTitle: "\xD6rnek sayfa",
    kind: "video",
    duration: 65,
    direct: true,
    sources: [
      { url: "https://cdn.example.com/v-720.mp4", mime: "video/mp4", label: "720p" },
      { url: "javascript:alert(1)", label: "k\xF6t\xFC" }
    ],
    manifest: "https://cdn.example.com/master.m3u8"
  };
  const floatAsk = (msg, match, timeout = 3e3) => new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (match(m)) {
        wsFloat.off("message", h);
        res(m);
      }
    };
    wsFloat.on("message", h);
    wsFloat.send(JSON.stringify(msg));
    setTimeout(() => {
      wsFloat.off("message", h);
      res(null);
    }, timeout);
  });
  const fmt = await floatAsk(
    { t: "float-formats", key: "https://example.com/watch|VIDEO", reqId: "r1", media: floatMedia },
    (m) => m.t === "float-formats"
  );
  ok("panel kalite iste\u011Fi yan\u0131tland\u0131", !!fmt && fmt.ok === true && fmt.reqId === "r1", JSON.stringify(fmt));
  ok("panel kaliteleri d\xF6nd\xFC", !!fmt && fmt.formats.length === 1 && fmt.formats[0].label === "720p");
  ok("panel dili d\xF6nd\xFC", !!fmt && fmt.language === "tr", String(fmt?.language));
  const sentFormats = floatCalls.find((c) => c.type === "formats");
  ok("panel medyas\u0131 uygulamaya iletildi", !!sentFormats && sentFormats.media.url.endsWith("/v.mp4"));
  ok(
    "g\xFCvenli olmayan <source> at\u0131ld\u0131",
    !!sentFormats && sentFormats.media.sources.length === 1 && sentFormats.media.sources[0].label === "720p",
    JSON.stringify(sentFormats?.media?.sources)
  );
  ok(
    "oynat\u0131c\u0131n\u0131n manifesti korundu",
    sentFormats?.media?.manifest === "https://cdn.example.com/master.m3u8",
    String(sentFormats?.media?.manifest)
  );
  ok("panel anahtar\u0131 iletildi", sentFormats?.key === "https://example.com/watch|VIDEO");
  const dlFmt = await floatAsk(
    {
      t: "float-download",
      key: "https://example.com/watch|VIDEO",
      reqId: "d1",
      kind: "video",
      formatId: "src:0",
      media: floatMedia
    },
    (m) => m.t === "float-download"
  );
  ok("panel indirme iste\u011Fi yan\u0131tland\u0131", !!dlFmt && dlFmt.ok === true && dlFmt.reqId === "d1", JSON.stringify(dlFmt));
  const sentDl = floatCalls.find((c) => c.type === "download");
  ok("indirilen sat\u0131r iletildi", sentDl?.kind === "video" && sentDl?.formatId === "src:0");
  const act = await floatAsk(
    { t: "float-action", action: "formats", key: "k", media: floatMedia },
    (m) => m.t === "ack" && m.ref === "float-action"
  );
  ok("panel eylemi yan\u0131tland\u0131", !!act && act.ok === true, JSON.stringify(act));
  ok("Formatlar\u2026 ana pencereye y\xF6nlendirildi", floatCalls.some((c) => c.type === "openFormats"));
  wsFloat.close();
  await sleep(150);
  const denied = await new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "ack" && m.ok === false) {
        ws2.off("message", h);
        res(m);
      }
    };
    ws2.on("message", h);
    ws2.send(JSON.stringify({ t: "float-formats", media: floatMedia }));
    setTimeout(() => {
      ws2.off("message", h);
      res(null);
    }, 2500);
  });
  ok(
    "eklenti d\u0131\u015F\u0131 k\xF6kende panel iste\u011Fi reddedilir",
    !!denied && /köken/.test(denied.message || ""),
    denied?.message
  );
  const beforeDl = mgrExt.list().length;
  ws2.send(JSON.stringify({ t: "download", url: `${base}/small.txt`, name: "k\xFC\xE7\xFCk.txt" }));
  await sleep(700);
  ok("eklentiden indirme eklendi", mgrExt.list().length === beforeDl + 1);
  const fromExt = mgrExt.list()[0];
  ok("URL aktar\u0131ld\u0131", fromExt.url.endsWith("/small.txt"), fromExt.url);
  ws2.send(
    JSON.stringify({
      t: "detect",
      page: { url: "https://youtube.com/watch?v=x", title: "Test Video" },
      items: [{ kind: "video", url: "https://x/v.mp4", title: "Test Video", mime: "video/mp4" }]
    })
  );
  const ack = await new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "ack" && m.ref === "detect") {
        ws2.off("message", h);
        res(m);
      }
    };
    ws2.on("message", h);
    setTimeout(() => res(null), 2500);
  });
  ok("detect ack al\u0131ndi", ack && ack.ok === true, JSON.stringify(ack));
  const statusMsg = await new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "status") {
        ws2.off("message", h);
        res(m);
      }
    };
    ws2.on("message", h);
    ext.broadcastStatus();
    setTimeout(() => res(null), 2500);
  });
  ok("status yay\u0131nland\u0131", statusMsg && Array.isArray(statusMsg.items), JSON.stringify(statusMsg));
  ws2.close();
  await sleep(200);
  ok("ba\u011Flant\u0131 kapan\u0131nca client listesi bo\u015Fal\u0131r", ext.status.clients.length === 0);
  await ext.stop();
  ok("sunucu durdu", ext.status.running === false);
  section("11. Kuyru\u011Fa ekle (queue)");
  const storeQ = new FakeStore(makeSettings({ general: { autoStart: false } }));
  storeQ.getSettings().general.downloadDir = join(outDir, "dlq");
  const mgrQ = new DownloadManager(storeQ);
  const qa = await mgrQ.add({
    url: `${base}/small.txt`,
    totalBytes: FILES["/small.txt"].length,
    silent: true
  });
  ok("autoStart kapal\u0131 \u2192 kuyrukta", mgrQ.get(qa.id).state === "queued", mgrQ.get(qa.id).state);
  mgrQ.queue(qa.id);
  await sleep(400);
  ok("queue() sonras\u0131 hemen ba\u015Flamaz", mgrQ.get(qa.id).state === "queued", mgrQ.get(qa.id).state);
  mgrQ.schedule(qa.id, Date.now() + 3600 * 1e3);
  ok("zamanland\u0131", mgrQ.get(qa.id).state === "scheduled", mgrQ.get(qa.id).state);
  mgrQ.queue(qa.id);
  ok("scheduled \u2192 queued", mgrQ.get(qa.id).state === "queued", mgrQ.get(qa.id).state);
  ok("scheduledAt kald\u0131r\u0131ld\u0131", !mgrQ.get(qa.id).scheduledAt);
  const itQ = mgrQ.get(qa.id);
  itQ.state = "error";
  itQ.errorMessage = "test hatas\u0131";
  mgrQ.queue(qa.id);
  ok(
    "error \u2192 queued + hata temizlendi",
    mgrQ.get(qa.id).state === "queued" && !mgrQ.get(qa.id).errorMessage,
    mgrQ.get(qa.id).state
  );
  const storeQC = new FakeStore(makeSettings());
  storeQC.getSettings().general.downloadDir = join(outDir, "dlqc");
  const mgrQC = new DownloadManager(storeQC);
  const qc = await mgrQC.add({ url: `${base}/small.txt`, silent: true });
  deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    const it = mgrQC.get(qc.id);
    if (it.state === "completed" || it.state === "error") break;
    await sleep(100);
  }
  ok("k\xFC\xE7\xFCk dosya tamamland\u0131", mgrQC.get(qc.id).state === "completed", mgrQC.get(qc.id).state);
  mgrQC.queue(qc.id);
  ok("completed korunur", mgrQC.get(qc.id).state === "completed", mgrQC.get(qc.id).state);
  const storeQD = new FakeStore(makeSettings());
  storeQD.getSettings().general.downloadDir = join(outDir, "dlqd");
  storeQD.getSettings().general.speedLimitMbps = 2;
  const mgrQD = new DownloadManager(storeQD);
  const qd = await mgrQD.add({
    url: `${base}/medium.bin`,
    savePath: join(outDir, "qd.bin"),
    silent: true
  });
  deadline = Date.now() + 2e4;
  while (Date.now() < deadline && mgrQD.get(qd.id).state !== "downloading") await sleep(100);
  ok("indirme ba\u015Flad\u0131", mgrQD.get(qd.id).state === "downloading", mgrQD.get(qd.id).state);
  if (mgrQD.get(qd.id).state === "downloading") {
    mgrQD.queue(qd.id);
    const qdi = mgrQD.get(qd.id);
    ok("downloading \u2192 queued", qdi.state === "queued", qdi.state);
    ok("h\u0131z s\u0131f\u0131rland\u0131", qdi.progress.speed === 0, `${qdi.progress.speed}`);
  }
  mgrQD.remove(qd.id, true);
  mgrQC.remove(qc.id, true);
  mgrQ.remove(qa.id, false);
  section("Y\xFCzen panel \u2014 video kaliteleri ve ses dosyalar\u0131");
  const ff = await import(mod(join(root, "tests", ".build", "floatFormats.mjs")));
  ok("HLS adresi tan\u0131n\u0131r", ff.isStreamAddress("https://cdn.example.com/live/index.m3u8?x=1"));
  ok("mp4 yay\u0131n say\u0131lmaz", !ff.isStreamAddress("https://cdn.example.com/v.mp4"));
  ok(
    "\xE7\xF6z\xFCn\xFCrl\xFCk ayr\u0131\u015Ft\u0131rma",
    ff.heightOf("1920x1080") === 1080 && ff.heightOf("1080p") === 1080 && ff.heightOf(null) === null
  );
  ok("etiketten kalite", ff.qualityLabel("HD 720p", "https://x/y.mp4") === "720p");
  ok("adresten kalite", ff.qualityLabel("", "https://cdn/x_1080.mp4") === "1080p");
  ok(
    "ana sayfa ve ak\u0131\u015F listeleme sayfas\u0131 say\u0131l\u0131r",
    ff.isGenericPage("https://www.instagram.com/") && ff.isGenericPage("https://www.instagram.com/explore/") && ff.isGenericPage("https://www.instagram.com/reels/") && ff.isGenericPage("https://www.instagram.com/reels/audio/123456/") && ff.isGenericPage("https://www.instagram.com/kullanici/") && ff.isGenericPage("https://www.reddit.com/r/aww/") && ff.isGenericPage("https://www.youtube.com/") && ff.isGenericPage("https://x.com/home") && ff.isGenericPage("")
  );
  ok(
    "tek g\xF6nderi/video sayfas\u0131 \xE7\xF6z\xFClebilir say\u0131l\u0131r",
    !ff.isGenericPage("https://www.instagram.com/p/CxYz123/") && !ff.isGenericPage("https://www.instagram.com/reel/CxYz123/") && !ff.isGenericPage("https://www.instagram.com/reels/CxYz123/") && !ff.isGenericPage("https://www.instagram.com/reels/CxYz123/?igsh=abc") && !ff.isGenericPage("https://www.reddit.com/r/test/comments/abc123/baslik/") && !ff.isGenericPage("https://www.youtube.com/watch?v=abc123") && !ff.isGenericPage("https://x.com/user/status/123456") && !ff.isGenericPage("https://www.tiktok.com/@user/video/123")
  );
  ok(
    'yt-dlp "Unsupported URL" hatas\u0131 tan\u0131n\u0131r',
    ff.classifyProbeError("ERROR: Unsupported URL: https://www.instagram.com/") === "unsupported"
  );
  ok(
    "oturum/\xE7erez hatas\u0131 tan\u0131n\u0131r",
    ff.classifyProbeError(
      "ERROR: [Instagram] Requested content is not available, rate-limit reached or login required"
    ) === "login" && ff.classifyProbeError("Sign in to confirm you are not a bot") === "login"
  );
  ok(
    "eri\u015Fime kapal\u0131 i\xE7erik tan\u0131n\u0131r",
    ff.classifyProbeError("ERROR: Video unavailable") === "unavailable" && ff.classifyProbeError("HTTP Error 404: Not Found") === "unavailable"
  );
  ok("bilinmeyen hata ham metne d\xFC\u015Fmez", ff.classifyProbeError("ERROR: something odd") === null);
  const probeRows = ff.formatsFromProbe([
    { formatId: "137", ext: "mp4", resolution: "1920x1080", fps: 30, vcodec: "avc1", acodec: null, tbr: 4500, sizeBytes: 3e8, note: "", isAudioOnly: false },
    { formatId: "137dup", ext: "webm", resolution: "1920x1080", fps: 60, vcodec: "vp9", acodec: null, tbr: 5200, sizeBytes: null, note: "", isAudioOnly: false },
    { formatId: "136", ext: "mp4", resolution: "1280x720", fps: 30, vcodec: "avc1", acodec: null, tbr: 2500, sizeBytes: null, note: "", isAudioOnly: false },
    { formatId: "135", ext: "mp4", resolution: "854x480", fps: 30, vcodec: "avc1", acodec: null, tbr: 1200, sizeBytes: null, note: "", isAudioOnly: false },
    { formatId: "18", ext: "mp4", resolution: "640x360", fps: 30, vcodec: "avc1", acodec: "mp4a", tbr: 700, sizeBytes: null, note: "", isAudioOnly: false },
    { formatId: "140", ext: "m4a", resolution: null, fps: null, vcodec: null, acodec: "mp4a", tbr: 129, sizeBytes: 4e6, note: "", isAudioOnly: true },
    { formatId: "251", ext: "webm", resolution: null, fps: null, vcodec: null, acodec: "opus", tbr: 160, sizeBytes: null, note: "", isAudioOnly: true }
  ]);
  const vids = probeRows.filter((r) => r.kind === "video");
  const auds = probeRows.filter((r) => r.kind === "audio");
  ok("video kaliteleri tekille\u015Fti", vids.length === 4, JSON.stringify(vids.map((v) => v.label)));
  ok(
    'en y\xFCksek kalite ba\u015Fta ve "en iyi"',
    vids[0].label === "1080p" && vids[0].best === true,
    JSON.stringify(vids[0])
  );
  ok("ayn\u0131 y\xFCkseklikten y\xFCksek bit h\u0131z\u0131 se\xE7ildi", vids[0].formatId === "137dup", vids[0].formatId);
  ok(
    "kalite ayr\u0131nt\u0131s\u0131 (kapsay\u0131c\u0131 \xB7 \xE7\xF6z\xFCn\xFCrl\xFCk \xB7 fps)",
    /WEBM/.test(vids[0].detail || "") && /1920×1080/.test(vids[0].detail || "") && /60 fps/.test(vids[0].detail || ""),
    vids[0].detail
  );
  ok("ses dosyalar\u0131 listelendi", auds.length === 2, JSON.stringify(auds.map((a) => a.label)));
  ok(
    "ses etiketi + bit h\u0131z\u0131",
    auds.some((a) => a.label === "M4A") && /kbps/.test(auds.map((a) => a.detail).join(" ")),
    JSON.stringify(auds)
  );
  const hlsRows = ff.formatsFromProbe([
    { formatId: "135", ext: "mp4", resolution: "854x480", fps: 30, vcodec: "avc1", acodec: null, tbr: 364, sizeBytes: 40922653, note: "", isAudioOnly: false, protocol: "https" },
    { formatId: "231", ext: "mp4", resolution: "854x480", fps: 30, vcodec: "avc1", acodec: null, tbr: 1011, sizeBytes: null, note: "", isAudioOnly: false, protocol: "m3u8_native", hls: true },
    { formatId: "251", ext: "webm", resolution: null, fps: null, vcodec: null, acodec: "opus", tbr: 137, sizeBytes: 15415589, note: "", isAudioOnly: true, protocol: "https" },
    { formatId: "251h", ext: "webm", resolution: null, fps: null, vcodec: null, acodec: "opus", tbr: 200, sizeBytes: null, note: "", isAudioOnly: true, protocol: "m3u8_native", hls: true }
  ]);
  const hlsVid = hlsRows.find((r) => r.kind === "video");
  const hlsAud = hlsRows.find((r) => r.kind === "audio");
  ok("HLS video kopyas\u0131 yerine DASH ak\u0131\u015F\u0131 se\xE7ilir", hlsVid?.formatId === "135", hlsVid?.formatId);
  ok("HLS ses kopyas\u0131 yerine DASH sesi se\xE7ilir", hlsAud?.formatId === "251", hlsAud?.formatId);
  const sourceMedia = {
    url: "https://cdn.example.com/1080.mp4",
    pageUrl: "https://example.com/watch",
    title: "\xD6rnek video",
    kind: "video",
    direct: true,
    sources: [
      { url: "https://cdn.example.com/1080.mp4", mime: "video/mp4", label: "1080p" },
      { url: "https://cdn.example.com/720.mp4", mime: "video/mp4", label: "720p" },
      { url: "https://cdn.example.com/480.mp4", mime: "video/mp4", label: "480p" }
    ]
  };
  const srcRows = ff.formatsFromSources(sourceMedia, { audioExtract: true });
  const srcVids = srcRows.filter((r) => r.kind === "video");
  const srcAuds = srcRows.filter((r) => r.kind === "audio");
  ok(
    "oynat\u0131c\u0131 <source> listesi kalitelere d\xF6n\xFC\u015Ft\xFC",
    srcVids.length === 3 && srcVids[0].label === "1080p" && srcVids[2].label === "480p",
    JSON.stringify(srcVids.map((v) => v.label))
  );
  ok("kalite sat\u0131r\u0131 do\u011Frudan adresi ta\u015F\u0131r", srcVids[0].url === "https://cdn.example.com/1080.mp4");
  ok("en iyi kalite i\u015Faretli", srcVids[0].best === true);
  ok(
    "sadece ses (MP3) se\xE7ene\u011Fi eklendi",
    srcAuds.length === 1 && srcAuds[0].labelKey === "audioMp3",
    JSON.stringify(srcAuds)
  );
  const singleRow = ff.formatsFromSources(
    { url: "https://cdn.example.com/movie.webm", pageUrl: "", title: "t", kind: "video", direct: true },
    { audioExtract: false }
  );
  ok(
    "tek dosyada \xF6zg\xFCn kalite sat\u0131r\u0131",
    singleRow.length === 1 && singleRow[0].labelKey === "origVideo" && singleRow[0].best === true,
    JSON.stringify(singleRow)
  );
  const audioRowsOnly = ff.formatsFromSources(
    { url: "https://cdn.example.com/song.m4a", pageUrl: "", title: "t", kind: "audio", direct: true },
    { audioExtract: true }
  );
  ok(
    "ses medyas\u0131nda \xF6zg\xFCn ses sat\u0131r\u0131",
    audioRowsOnly.length === 1 && audioRowsOnly[0].kind === "audio" && audioRowsOnly[0].formatId === "direct",
    JSON.stringify(audioRowsOnly)
  );
  const extractorMedia = {
    url: "https://v.redd.it/abc123/DASH_720.mp4",
    pageUrl: "https://www.reddit.com/r/test/comments/abc123/baslik/",
    title: "\xD6rnek",
    kind: "video",
    direct: true,
    needsExtractor: true,
    sources: [{ url: "https://v.redd.it/abc123/DASH_720.mp4", mime: "video/mp4" }]
  };
  ok(
    "ekstrakt\xF6r sayfas\u0131nda kaynak olsa da \xF6nce yt-dlp denenir",
    ff.probeFirstTarget(extractorMedia) === extractorMedia.pageUrl,
    ff.probeFirstTarget(extractorMedia)
  );
  ok(
    "tek do\u011Frudan kaynak tek sat\u0131r verir (tam liste yt-dlp\u2019den)",
    ff.formatsFromSources(extractorMedia, { audioExtract: true }).filter(
      (r) => r.kind === "video"
    ).length === 1
  );
  ok(
    "ekstrakt\xF6r olmayan sitede kaynak listesi yeterli",
    ff.probeFirstTarget({
      url: "https://cdn.example.com/1080.mp4",
      pageUrl: "https://example.com/watch",
      needsExtractor: false
    }) === null
  );
  ok(
    "ak\u0131\u015F/profil sayfas\u0131nda (g\xF6nderi adresi yok) yt-dlp denenmez",
    ff.probeFirstTarget({
      url: "https://cdn.example.com/1080.mp4",
      pageUrl: "https://www.reddit.com/r/aww/",
      needsExtractor: true
    }) === null
  );
  const hasYtdlp = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" }).status === 0;
  if (!hasYtdlp) {
    console.log("  - yt-dlp bulunamad\u0131: manifest sondas\u0131 atland\u0131");
  } else {
    const { YtdlpRunner } = await import(mod(join(root, "tests", ".build", "ytdlp.mjs")));
    const runner = new YtdlpRunner(
      {
        findYtdlp: () => "yt-dlp",
        findFfmpeg: () => "ffmpeg",
        missingYtdlpError: () => new Error("yt-dlp yok")
      },
      join(outDir, "ytdlp-tmp")
    );
    const manifestProbe = await runner.probe({
      url: `${base}/master.m3u8`,
      useCookies: false,
      impersonate: false
    });
    const manifestRows = ff.formatsFromProbe(manifestProbe.formats);
    const manifestVids = manifestRows.filter((r) => r.kind === "video");
    ok(
      "HLS manifestinden t\xFCm video kaliteleri \xE7\u0131kar",
      manifestProbe.ok && manifestVids.length >= 2 && manifestVids[0].label === "720p" && manifestVids[1].label === "360p",
      `sat\u0131r=${JSON.stringify(manifestVids.map((v) => v.label))} ok=${manifestProbe.ok} hata=${manifestProbe.error || ""}`
    );
    ok(
      "manifest sat\u0131rlar\u0131 manifest adresini ta\u015F\u0131yabilir",
      manifestVids.every((r) => typeof r.formatId === "string" && r.formatId.length > 0)
    );
  }
  section("Y\xFCzen panel \u2014 uygulama k\xF6pr\xFCs\xFC (FloatService)");
  const fsvcMod = await import(mod(join(root, "tests", ".build", "floatService.mjs")));
  const fstore = new FakeStore(makeSettings());
  let probeCount = 0;
  const svcCalls = [];
  const svc = new fsvcMod.FloatService({
    store: fstore,
    probeFormats: async () => {
      probeCount++;
      return {
        ok: true,
        formats: [
          { formatId: "h1080", kind: "video", label: "1080p", best: true },
          { formatId: "a1", kind: "audio", label: "M4A" }
        ]
      };
    },
    download: async (m, k, f) => {
      svcCalls.push({ m, k, f });
      return { ok: true, message: "kuyru\u011Fa eklendi" };
    },
    openFormats: (m) => svcCalls.push({ open: m.url }),
    showMainWindow: () => svcCalls.push({ show: true })
  });
  const svcMedia = {
    url: "https://cdn.example.com/v.mp4",
    pageUrl: "https://example.com/watch",
    title: "V",
    kind: "video"
  };
  const firstList = await svc.formats(svcMedia, "k1");
  ok(
    "FloatService kalite listesi \xFCretir",
    firstList.ok && firstList.formats.length === 2 && firstList.language === "tr",
    JSON.stringify(firstList)
  );
  await svc.formats(svcMedia, "k1");
  ok("ayn\u0131 medya i\xE7in sonda tekrarlanmaz", probeCount === 1, String(probeCount));
  const chosen = await svc.download(svcMedia, "video", "h1080", "k1");
  ok("se\xE7ilen sat\u0131r indirilir", chosen.ok && svcCalls[0]?.f?.formatId === "h1080");
  const chosenAudio = await svc.download(svcMedia, "audio", void 0, "k1");
  ok(
    "format kimli\u011Fi yoksa en iyi ses sat\u0131r\u0131 se\xE7ilir",
    chosenAudio.ok && svcCalls[1]?.f?.formatId === "a1"
  );
  const chosenBad = await svc.download(svcMedia, "video", "yok", "k1");
  ok("bilinmeyen sat\u0131r indirilmez", chosenBad.ok === false);
  fstore.getSettings().extension.floatingPanel = false;
  const offList = await svc.formats(svcMedia, "k1");
  ok("panel ayar\u0131 kapal\u0131yken liste verilmez", offList.ok === false && offList.formats.length === 0);
  const offDl = await svc.download(svcMedia, "video", void 0, "k1");
  ok("panel ayar\u0131 kapal\u0131yken indirme yap\u0131lmaz", offDl.ok === false);
  section("Y\xFCzen panel \u2014 kalite sat\u0131rlar\u0131n\u0131n boyutlar\u0131");
  const fsizes = await import(mod(join(root, "tests", ".build", "floatSizes.mjs")));
  const sized = await fsizes.fillFormatSizes([
    { formatId: "src:0", kind: "video", label: "1080p", url: `${base}/video.mp4` },
    { formatId: "src:1", kind: "video", label: "720p", url: `${base}/medium.bin` },
    { formatId: "src:2", kind: "video", label: "HLS", url: `${base}/live/index.m3u8` },
    {
      formatId: "src:3",
      kind: "audio",
      label: "M4A",
      url: `${base}/small.txt`,
      sizeBytes: 12345
    },
    { formatId: "audio:mp3", kind: "audio", label: "MP3" }
  ]);
  ok(
    "boyutlar Content-Length ile doldu",
    sized[0].sizeBytes === FILES["/video.mp4"].length && sized[1].sizeBytes === FILES["/medium.bin"].length,
    `${sized[0].sizeBytes} / ${sized[1].sizeBytes}`
  );
  ok("HLS sat\u0131r\u0131 sorgulanmaz", sized[2].sizeBytes === void 0);
  ok("bilinen boyut korunur", sized[3].sizeBytes === 12345, String(sized[3].sizeBytes));
  ok("adressiz sat\u0131r (MP3) boyutsuz kal\u0131r", sized[4].sizeBytes === void 0);
  const noWait = await fsizes.fillFormatSizes(
    [{ formatId: "src:0", kind: "video", label: "1080p", url: `${base}/video.mp4` }],
    { timeoutMs: 1, budgetMs: 0 }
  );
  ok("b\xFCt\xE7e dolunca beklemeden d\xF6ner", noWait[0].sizeBytes === void 0);
  section("Medya \u2014 birle\u015Ftirme sonras\u0131 \xE7\u0131kt\u0131 yolu");
  const fragOut = join(root, "tests", ".build", "out.f251.webm");
  const mergedOut = join(root, "tests", ".build", "out.mkv");
  writeFileSync(fragOut, "parca");
  writeFileSync(mergedOut, "birlesmis");
  ok(
    "birle\u015Fmi\u015F dosya par\xE7a ad\u0131na tercih edilir",
    pickExistingOutput([fragOut, mergedOut], "yedek") === mergedOut,
    pickExistingOutput([fragOut, mergedOut], "yedek")
  );
  unlinkSync(mergedOut);
  ok(
    "silinen son yol atlan\u0131r, var olan se\xE7ilir",
    pickExistingOutput([fragOut, mergedOut], "yedek") === fragOut
  );
  unlinkSync(fragOut);
  ok("hi\xE7biri yoksa son bildirilen yol", pickExistingOutput([mergedOut], "yedek") === mergedOut);
  ok("bo\u015F liste yede\u011Fe d\xFC\u015Fer", pickExistingOutput([], "yedek") === "yedek");
  server.close();
  console.log("\n" + "\u2500".repeat(58));
  console.log(`SONU\xC7: ${passed} ba\u015Far\u0131l\u0131, ${failed} ba\u015Far\u0131s\u0131z`);
  if (failed > 0) {
    console.log("\nBa\u015Far\u0131s\u0131zlar:");
    for (const f of failures) console.log("  \u2717 " + f);
    process.exit(1);
  }
  console.log("T\xFCm testler ge\xE7ti \u2713");
  process.exit(0);
}
main().catch((e) => {
  console.error("\nTEST CRASH:", e);
  server.close();
  process.exit(1);
});
