// src/main/extServer.ts
import { EventEmitter } from "events";
import { createServer } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
var EXTENSION_SCHEMES = [
  "chrome-extension:",
  "moz-extension:",
  "ms-browser-extension:",
  "safari-web-extension:"
];
var MAX_BODY = 512 * 1024;
var LOCAL_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function isExtensionOrigin(origin) {
  if (!origin) return false;
  try {
    return EXTENSION_SCHEMES.includes(new URL(origin).protocol);
  } catch {
    return false;
  }
}
function isLocalOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (!ba.length || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
function sanitizeFloatMedia(media) {
  if (!media || typeof media.url !== "string") return null;
  const sources = Array.isArray(media.sources) ? media.sources.slice(0, 8).map((s) => ({
    url: String(s?.url || "").slice(0, 2048),
    mime: s?.mime ? String(s.mime).slice(0, 80) : void 0,
    label: s?.label ? String(s.label).slice(0, 40) : void 0
  })).filter((s) => /^https?:\/\//i.test(s.url)) : [];
  return {
    url: String(media.url).slice(0, 2048),
    pageUrl: String(media.pageUrl || "").slice(0, 2048),
    title: String(media.title || "").slice(0, 300),
    pageTitle: String(media.pageTitle || "").slice(0, 300),
    kind: media.kind === "audio" ? "audio" : "video",
    duration: typeof media.duration === "number" ? media.duration : null,
    direct: media.direct === true,
    needsExtractor: media.needsExtractor === true,
    sources: sources.length ? sources : void 0,
    manifest: /^https?:\/\//i.test(String(media.manifest || "")) ? String(media.manifest).slice(0, 2048) : void 0,
    cookies: Array.isArray(media.cookies) ? media.cookies.slice(0, 80).filter((c) => c && typeof c.name === "string" && typeof c.value === "string").map((c) => ({
      name: String(c.name).slice(0, 120),
      value: String(c.value).slice(0, 4096),
      domain: String(c.domain || "").slice(0, 200),
      path: String(c.path || "/").slice(0, 200),
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      expirationDate: typeof c.expirationDate === "number" ? c.expirationDate : void 0
    })) : void 0
  };
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("G\xF6vde 256 KB s\u0131n\u0131r\u0131n\u0131 a\u015Ft\u0131"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Ge\xE7ersiz JSON"));
      }
    });
    req.on("error", reject);
  });
}
var ExtensionServer = class extends EventEmitter {
  constructor(store, manager, requestDownload, float, requestMediaDownload, version = "1.0.0") {
    super();
    this.requestDownload = requestDownload;
    this.float = float;
    this.requestMediaDownload = requestMediaDownload;
    this.version = version;
    this.setMaxListeners(50);
    this.store = store;
    this.manager = manager;
    this.syncSecret();
  }
  wss = null;
  httpServer = null;
  clients = /* @__PURE__ */ new Map();
  store;
  manager;
  port = 0;
  seq = 0;
  token = "";
  allowedOrigins = /* @__PURE__ */ new Set();
  /** /pair başarısız denemeleri: origin -> zaman damgaları (ms) */
  pairFailures = /* @__PURE__ */ new Map();
  PAIR_MAX_ATTEMPTS = 10;
  PAIR_WINDOW_MS = 15 * 60 * 1e3;
  // 15 dakika
  starting = null;
  syncSecret() {
    const cfg = this.store.getSettings().extension;
    this.token = cfg.token;
    this.allowedOrigins = new Set(cfg.allowedOrigins || []);
  }
  get status() {
    const cfg = this.store.getSettings().extension;
    return {
      running: this.httpServer !== null,
      port: this.port,
      pairingCode: cfg.pairingCode,
      paired: this.allowedOrigins.size > 0 || [...this.clients.values()].some((c) => c.paired),
      clients: [...this.clients.values()].map((c) => ({
        id: c.id,
        client: c.client,
        connectedAt: c.connectedAt,
        version: c.version
      }))
    };
  }
  async start() {
    const cfg = this.store.getSettings().extension;
    if (!cfg.enabled) return false;
    if (this.httpServer) return true;
    if (this.starting) return this.starting;
    this.starting = this.startOnce(cfg.port || 9789).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async startOnce(basePort) {
    this.syncSecret();
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        await this.listen(p);
        return true;
      } catch {
      }
    }
    this.emit("log", "hi\xE7bir portta dinlenemedi");
    return false;
  }
  listen(port) {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handleHttp(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
      server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head, wss));
      server.on("clientError", (_err, socket) => {
        try {
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        } catch {
        }
      });
      const onError = (err) => {
        server.removeListener("listening", onListening);
        try {
          wss.close();
        } catch {
        }
        if (err.code === "EADDRINUSE") reject(err);
        else {
          this.emit("log", `K\xF6pr\xFC hatas\u0131: ${err.message}`);
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.emit("log", `K\xF6pr\xFC hatas\u0131: ${err.message}`));
        const addr = server.address();
        this.httpServer = server;
        this.wss = wss;
        this.port = typeof addr === "object" && addr ? addr.port : port;
        this.emit("listening", this.port);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
  }
  // -------------------------------------------------------------------------
  // HTTP köprüsü
  // -------------------------------------------------------------------------
  corsHeaders(origin, allowed) {
    const headers = {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-IDMS-Token",
      // Chrome/Edge "Private Network Access": genel bir sayfadan/eklenti
      // bağlamından 127.0.0.1'e yapılan isteklerde ön kontrol bu başlığı
      // ister; yoksa istek tarayıcıda engellenir.
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    };
    if (allowed && origin) headers["Access-Control-Allow-Origin"] = origin;
    return headers;
  }
  json(res, code, payload, headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      ...headers
    });
    res.end(body);
  }
  async handleHttp(req, res) {
    const origin = String(req.headers.origin || "");
    const extensionOrigin = isExtensionOrigin(origin);
    const localOrigin = isLocalOrigin(origin);
    const allowed = extensionOrigin || localOrigin;
    const hostname = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!LOCAL_HOSTS.has(hostname)) {
      this.json(res, 421, { error: "Yaln\u0131zca yerel ba\u011Flant\u0131 kabul edilir" });
      return;
    }
    const headers = this.corsHeaders(origin, allowed);
    if (req.method === "OPTIONS") {
      if (!allowed) {
        this.json(res, 403, { error: "Yetkisiz k\xF6ken" });
        return;
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      this.json(res, 400, { error: "Ge\xE7ersiz istek" }, headers);
      return;
    }
    const route = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (route === "/info") {
        if (!allowed && origin) {
          this.json(res, 403, { error: "Yetkisiz k\xF6ken" });
          return;
        }
        const cfg = this.store.getSettings().extension;
        this.json(
          res,
          200,
          {
            app: "IDMS",
            version: this.appVersion(),
            protocol: 2,
            port: this.port,
            needsPairing: true,
            paired: this.allowedOrigins.size > 0,
            integration: cfg.enabled,
            /** Sayfada çizilen yüzen panel açık mı (içerik betiği bunu okur) */
            floatingPanel: cfg.floatingPanel !== false
          },
          headers
        );
        return;
      }
      if (route === "/pair") {
        if (req.method !== "POST") {
          this.json(res, 405, { error: "POST gerekli" }, headers);
          return;
        }
        if (!extensionOrigin) {
          this.json(res, 403, { error: "Yaln\u0131zca taray\u0131c\u0131 eklentileri e\u015Fle\u015Febilir" }, headers);
          return;
        }
        const now = Date.now();
        const failures = (this.pairFailures.get(origin) || []).filter((t) => now - t < this.PAIR_WINDOW_MS);
        if (failures.length >= this.PAIR_MAX_ATTEMPTS) {
          this.json(res, 429, { error: "\xC7ok fazla e\u015Fle\u015Ftirme denemesi; daha sonra tekrar deneyin" }, headers);
          return;
        }
        const body = await readJson(req);
        const code = String(body.code || "").trim().toUpperCase();
        const cfg = this.store.getSettings().extension;
        if (!code || !safeEqual(code, cfg.pairingCode.toUpperCase())) {
          failures.push(now);
          this.pairFailures.set(origin, failures);
          this.emit("log", "hatal\u0131 e\u015Fle\u015Ftirme kodu");
          this.json(res, 401, { error: "E\u015Fle\u015Ftirme kodu hatal\u0131" }, headers);
          return;
        }
        this.allowOrigin(origin);
        this.pairFailures.delete(origin);
        this.emit("paired", { origin, name: String(body.client || "") });
        this.emitStatus();
        this.json(
          res,
          200,
          {
            ok: true,
            token: this.token,
            port: this.port,
            app: "IDMS",
            version: this.appVersion()
          },
          headers
        );
        return;
      }
      if (route === "/whoami") {
        this.json(
          res,
          200,
          {
            origin: origin || null,
            paired: this.allowedOrigins.has(origin),
            knownExtension: extensionOrigin
          },
          headers
        );
        return;
      }
      if (route === "/rpc" || route === "/status") {
        if (req.method !== "POST" && route === "/rpc") {
          this.json(res, 405, { error: "POST gerekli" }, headers);
          return;
        }
        const token = String(req.headers["x-idms-token"] || "");
        if (!safeEqual(token, this.token)) {
          this.json(res, 401, { error: "Token gerekli; \xF6nce e\u015Fle\u015Ftirin" }, headers);
          return;
        }
        if (!this.allowedOrigins.has(origin)) {
          this.json(res, 403, { error: "Bu k\xF6ken e\u015Fle\u015Ftirilmemi\u015F" }, headers);
          return;
        }
        if (!this.store.getSettings().extension.enabled) {
          this.json(res, 503, { error: "Taray\u0131c\u0131 entegrasyonu kapal\u0131" }, headers);
          return;
        }
        if (route === "/status") {
          this.json(
            res,
            200,
            {
              ok: true,
              paired: true,
              port: this.port,
              summary: this.manager.summary(),
              items: this.manager.list().slice(0, 20).map((i) => ({
                id: i.id,
                name: i.name,
                percent: i.progress.percent,
                state: i.state
              }))
            },
            headers
          );
          return;
        }
        const body = await readJson(req);
        if (!body || typeof body.t !== "string") {
          this.json(res, 400, { error: "Mesaj t\xFCr\xFC (t) gerekli" }, headers);
          return;
        }
        const client = {
          id: `http_${++this.seq}`,
          ws: null,
          client: String(body.client || "extension").slice(0, 40),
          version: String(body.version || "").slice(0, 20),
          origin,
          connectedAt: Date.now(),
          paired: true,
          tokenAuthed: true,
          replies: []
        };
        await this.handleMessage(client, body);
        const ack = client.replies?.find((r) => r.t === "ack");
        this.json(
          res,
          200,
          {
            ok: ack ? ack.ok : true,
            id: ack?.id,
            message: ack?.message,
            replies: client.replies
          },
          headers
        );
        return;
      }
      this.json(res, 404, { error: `Bilinmeyen yol: ${route}` }, headers);
    } catch (err) {
      this.emit("log", `HTTP hatas\u0131: ${err?.message || err}`);
      this.json(res, 500, { error: String(err?.message || err) }, headers);
    }
  }
  allowOrigin(origin) {
    if (!origin || this.allowedOrigins.has(origin)) return;
    this.allowedOrigins.add(origin);
    this.store.patchSettings({
      extension: { allowedOrigins: [...this.allowedOrigins] }
    });
  }
  /** Token'ı yeniler ve tüm eklenti eşleştirmelerini iptal eder. */
  revoke() {
    const token = randomBytes(24).toString("hex");
    this.allowedOrigins.clear();
    this.store.patchSettings({
      extension: { token, allowedOrigins: [] }
    });
    this.token = token;
    for (const client of [...this.clients.values()]) {
      client.paired = false;
      if (client.ws) {
        try {
          client.ws.close(4001, "e\u015Fle\u015Ftirme iptal edildi");
        } catch {
        }
      }
    }
    this.emitStatus();
    return this.status;
  }
  // -------------------------------------------------------------------------
  // WebSocket köprüsü (canlı olaylar + yüzen panel)
  // -------------------------------------------------------------------------
  handleUpgrade(req, socket, head, wss) {
    const origin = String(req.headers.origin || "");
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/" && url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (origin && !isExtensionOrigin(origin) && !isLocalOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") || String(req.headers["x-idms-token"] || "");
    if (!token || !safeEqual(token, this.token) || origin && !this.allowedOrigins.has(origin)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, req, true, url);
    });
  }
  onConnection(ws, req, tokenAuthed, url) {
    const id = `c_${++this.seq}_${Date.now().toString(36)}`;
    const client = {
      id,
      ws,
      client: (url.searchParams.get("client") || (tokenAuthed ? "IDMS extension" : "unknown")).slice(0, 40),
      version: (url.searchParams.get("version") || "").slice(0, 20) || void 0,
      origin: String(req.headers.origin || ""),
      connectedAt: Date.now(),
      paired: tokenAuthed,
      tokenAuthed
    };
    this.clients.set(id, client);
    const cfg = this.store.getSettings().extension;
    this.send(client, {
      t: "welcome",
      appVersion: this.appVersion(),
      paired: tokenAuthed
      // Eşleştirme kodu buradan ASLA gönderilmez: token'sız istemci zaten
      // bağlanamaz, token'lı istemcinin koda ihtiyacı yoktur.
    });
    this.send(client, {
      t: "config",
      floatingPanel: cfg.floatingPanel !== false,
      enabled: cfg.enabled
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.send(client, { t: "ack", ok: false, message: "ge\xE7ersiz JSON" });
        return;
      }
      void this.handleMessage(client, msg);
    });
    ws.on("close", () => {
      this.clients.delete(id);
      this.emit("client-left", client.client);
      this.emitStatus();
    });
    ws.on("error", () => {
    });
    this.emit("client-added", client.client);
    if (tokenAuthed) this.sendStatusTo(client);
    this.emitStatus();
  }
  // -------------------------------------------------------------------------
  // Mesaj işleme
  // -------------------------------------------------------------------------
  /** Yüzen panel yalnızca eşleşmiş bir tarayıcı eklentisinden kabul edilir. */
  canUseFloat(client) {
    if (!this.float || !client.paired) return false;
    return EXTENSION_SCHEMES.some((scheme) => client.origin.startsWith(scheme));
  }
  async handleMessage(client, msg) {
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "float-formats" || msg.t === "float-download" || msg.t === "float-action") {
      if (!this.canUseFloat(client)) {
        this.send(client, { t: "ack", ok: false, message: "yetkisiz k\xF6ken" });
        return;
      }
      const key = typeof msg.key === "string" ? msg.key.slice(0, 2e3) : void 0;
      const media = sanitizeFloatMedia(msg.media);
      if (!media) {
        this.send(client, {
          t: msg.t === "float-download" ? "float-download" : "float-formats",
          reqId: msg.reqId,
          ok: false,
          message: "ge\xE7ersiz medya"
        });
        return;
      }
      try {
        if (msg.t === "float-formats") {
          const res = await this.float.formats(media, key);
          this.send(client, { t: "float-formats", reqId: msg.reqId, ...res });
          return;
        }
        if (msg.t === "float-download") {
          const kind = msg.kind === "audio" ? "audio" : "video";
          const res = await this.float.download(media, kind, msg.formatId, key);
          this.send(client, { t: "float-download", reqId: msg.reqId, ...res });
          return;
        }
        if (msg.action === "open-app") this.float.showMainWindow();
        else if (msg.action === "formats") this.float.openFormats(media);
        this.send(client, { t: "ack", ok: true, ref: "float-action" });
      } catch (err) {
        const message = String(err?.message || err);
        if (msg.t === "float-formats") {
          this.send(client, {
            t: "float-formats",
            reqId: msg.reqId,
            ok: false,
            formats: [],
            note: message,
            language: this.float?.language ?? "tr"
          });
        } else if (msg.t === "float-download") {
          this.send(client, { t: "float-download", reqId: msg.reqId, ok: false, message });
        } else {
          this.send(client, { t: "ack", ok: false, message });
        }
      }
      return;
    }
    if (msg.t !== "hello" && msg.t !== "ping" && !client.paired) {
      this.send(client, { t: "ack", ok: false, message: "e\u015Fle\u015Ftirme gerekli" });
      return;
    }
    switch (msg.t) {
      case "hello": {
        client.client = String(msg.client || "extension").slice(0, 40);
        client.version = String(msg.version || "").slice(0, 20);
        if (!client.paired) {
          this.send(client, { t: "welcome", appVersion: this.appVersion(), paired: false });
          this.send(client, { t: "ack", ok: false, message: "e\u015Fle\u015Ftirme gerekli" });
          break;
        }
        this.send(client, {
          t: "welcome",
          appVersion: this.appVersion(),
          paired: true
        });
        this.emit("paired", { origin: client.origin, name: client.client });
        this.emitStatus();
        this.sendStatusTo(client);
        break;
      }
      case "ping":
        this.send(client, { t: "pong" });
        break;
      case "open-app":
        this.emit("open-app-requested");
        this.send(client, { t: "ack", ok: true, ref: "open-app" });
        break;
      case "detect": {
        const items = Array.isArray(msg.items) ? msg.items.slice(0, 100) : [];
        const page = msg.page || { url: "", title: "" };
        this.emit("media-detected", {
          count: items.length,
          title: String(page.title || page.url || "").slice(0, 200)
        });
        this.send(client, { t: "ack", ok: true, ref: "detect" });
        break;
      }
      case "download": {
        const url = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          this.send(client, { t: "ack", ok: false, message: "ge\xE7ersiz URL" });
          break;
        }
        try {
          const cookie = (Array.isArray(msg.cookies) ? msg.cookies : []).filter((c) => c && typeof c.name === "string" && typeof c.value === "string").map((c) => `${String(c.name).replace(/[;\r\n]/g, "")}=${String(c.value).replace(/[\r\n]/g, "")}`).join("; ");
          const headers = {};
          if (cookie) headers.Cookie = cookie;
          const referrer = String(msg.referrer || msg.pageUrl || "");
          if (/^https?:\/\//i.test(referrer)) headers.Referer = referrer;
          const req = {
            url,
            pageUrl: msg.pageUrl,
            name: msg.name,
            silent: false,
            // onay ayarı yöneticide uygulanır
            headers
          };
          const item = this.requestDownload ? await this.requestDownload(req) : await this.manager.add(req);
          if (!item || !item.id) {
            this.send(client, {
              t: "ack",
              ok: false,
              message: "IDMS indirmeyi ba\u015Flatmad\u0131 (onay bekleniyor / iptal edildi)"
            });
            break;
          }
          this.send(client, { t: "ack", ok: true, id: item.id });
          this.emit("download-requested", { url, name: msg.name });
        } catch (err) {
          this.send(client, { t: "ack", ok: false, message: String(err?.message || err) });
        }
        break;
      }
      case "download-media": {
        const url = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          this.send(client, { t: "ack", ok: false, message: "ge\xE7ersiz URL" });
          break;
        }
        const payload = {
          url,
          pageUrl: msg.pageUrl,
          quality: msg.quality,
          cookies: msg.cookies
        };
        try {
          if (this.requestMediaDownload) {
            const item = await this.requestMediaDownload(payload);
            if (!item || !item.id) {
              this.send(client, {
                t: "ack",
                ok: false,
                message: "Medya indirmesi ba\u015Flat\u0131lamad\u0131 (yt-dlp kurulu mu?)"
              });
              break;
            }
            this.send(client, { t: "ack", ok: true, id: item.id, ref: "download-media" });
          } else {
            this.emit("media-download-requested", payload);
            this.send(client, { t: "ack", ok: true, ref: "download-media" });
          }
        } catch (err) {
          this.send(client, { t: "ack", ok: false, message: String(err?.message || err) });
        }
        break;
      }
      case "unpair": {
        this.allowedOrigins.delete(client.origin);
        this.store.patchSettings({ extension: { allowedOrigins: [...this.allowedOrigins] } });
        client.paired = false;
        this.emitStatus();
        this.send(client, { t: "ack", ok: true, ref: "unpair" });
        break;
      }
      case "probe": {
        this.emit("probe-requested", { url: msg.url });
        break;
      }
      default:
        this.send(client, { t: "ack", ok: false, message: "bilinmeyen mesaj" });
    }
  }
  appVersion() {
    return this.version;
  }
  send(client, msg) {
    if (client.replies) {
      client.replies.push(msg);
      return;
    }
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(msg));
      } catch {
      }
    }
  }
  /** Tüm bağlı (eşleşmiş) eklentilere yayın */
  broadcast(msg) {
    for (const c of this.clients.values()) {
      if (c.paired) this.send(c, msg);
    }
  }
  /** İndirme durumu özetini eklentiye iletir (rozet için) */
  sendStatusTo(client) {
    const items = this.manager.list().slice(0, 20);
    this.send(client, {
      t: "status",
      ...this.manager.summary(),
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        percent: i.progress.percent,
        state: i.state
      }))
    });
  }
  broadcastStatus() {
    const items = this.manager.list().slice(0, 20);
    this.broadcast({
      t: "status",
      ...this.manager.summary(),
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        percent: i.progress.percent,
        state: i.state
      }))
    });
  }
  broadcastToast(title, message, stage) {
    this.broadcast({ t: "toast", title, message, stage });
  }
  /** Panel ayarı değişti: içerik betikleri rozeti hemen gizlesin/göstersin. */
  broadcastConfig() {
    const cfg = this.store.getSettings().extension;
    this.broadcast({
      t: "config",
      floatingPanel: cfg.floatingPanel !== false,
      enabled: cfg.enabled
    });
  }
  emitStatus() {
    this.emit("status", this.status);
  }
  async stop() {
    for (const c of this.clients.values()) {
      try {
        c.ws?.close();
      } catch {
      }
    }
    this.clients.clear();
    try {
      this.wss?.close();
    } catch {
    }
    await new Promise((resolve) => {
      if (!this.httpServer) return resolve();
      const done = () => resolve();
      this.httpServer.close(done);
      setTimeout(done, 1e3);
    });
    this.wss = null;
    this.httpServer = null;
    this.port = 0;
    this.emitStatus();
  }
};
export {
  ExtensionServer,
  sanitizeFloatMedia
};
