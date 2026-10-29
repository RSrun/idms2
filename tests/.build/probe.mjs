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
var USER_AGENT = UA;
export {
  USER_AGENT,
  buildDownloadHeaders,
  filenameFromDisposition,
  filenameFromUrl,
  probeUrl,
  sanitizeFilename
};
