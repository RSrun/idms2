// src/main/floatFormats.ts
var STREAM_RE = /\.m3u8(\?|#|$)|\.mpd(\?|#|$)|\/manifest|format=m3u8/i;
function isStreamAddress(url) {
  return STREAM_RE.test(url);
}
var GENERIC_SEGMENTS = /* @__PURE__ */ new Set([
  "explore",
  "search",
  "results",
  "feed",
  "home",
  "trending",
  "discover",
  "foryou",
  "tag",
  "tags",
  "hashtag",
  "reels",
  "stories",
  "notifications",
  "inbox",
  "profile",
  "settings"
]);
var NOT_ITEM_SEGMENTS = /* @__PURE__ */ new Set(["audio", "highlights", "saved", "liked"]);
function isSingleItemPath(segments) {
  if (segments[0] !== "reels") return false;
  const id = segments[1] || "";
  return /^[a-z0-9_-]{5,}$/.test(id) && !NOT_ITEM_SEGMENTS.has(id);
}
function isGenericPage(url) {
  if (!url) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  for (const key of ["v", "list", "video_id", "story_fbid"]) {
    if (parsed.searchParams.get(key)) return false;
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length === 0) return true;
  if (isSingleItemPath(segments)) return false;
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (/(^|\.)reddit\.com$/i.test(host) && !segments.includes("comments")) {
    if (segments[0] === "r" || segments[0] === "user" || segments[0] === "u") return true;
  }
  if (/(^|\.)instagram\.com$/i.test(host) && segments.length === 1) return true;
  return GENERIC_SEGMENTS.has(segments[0]);
}
function classifyProbeError(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/unsupported url|is not a valid url/i.test(text)) return "unsupported";
  if (/log ?in|login required|sign in|cookie|authenticat|private|members[- ]only|age.?restrict|rate.?limit|too many requests|\b429\b|consent/i.test(
    text
  )) {
    return "login";
  }
  if (/not available|unavailable|no video|no formats|does not exist|removed|not found|\b404\b|\b410\b|no media/i.test(
    text
  )) {
    return "unavailable";
  }
  return null;
}
function heightOf(resolution) {
  if (!resolution) return null;
  const m = /(\d{3,4})\s*[x×]\s*(\d{3,4})/.exec(resolution);
  if (m) return Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
  const p = /^(\d{3,4})p?$/i.exec(resolution.trim());
  if (p) return parseInt(p[1], 10);
  return null;
}
function probeFirstTarget(media) {
  if (!media.needsExtractor) return null;
  const target = media.pageUrl || media.url || "";
  if (!/^https?:\/\//i.test(target)) return null;
  if (isGenericPage(target)) return null;
  return target;
}
function score(f) {
  return f.tbr || 0 || (f.sizeBytes ? f.sizeBytes / 1024 : 0);
}
function betterFormat(a, b) {
  if (!!a.hls !== !!b.hls) return !a.hls;
  return score(a) > score(b);
}
function videoDetail(f) {
  const bits = [f.ext.toUpperCase()];
  const res = f.resolution ? f.resolution.replace(/\s*[x×]\s*/i, "\xD7") : "";
  if (res) bits.push(res);
  if (typeof f.fps === "number" && f.fps > 0) bits.push(`${Math.round(f.fps)} fps`);
  return bits.join(" \xB7 ");
}
function audioDetail(f) {
  const bits = [];
  if (f.tbr && f.tbr > 0) bits.push(`${Math.round(f.tbr)} kbps`);
  else if (f.sizeBytes) bits.push(`${Math.round(f.sizeBytes / 1024)} KB`);
  return bits.join(" \xB7 ");
}
function formatsFromProbe(formats, opts = {}) {
  const maxVideo = opts.maxVideo ?? 6;
  const maxAudio = opts.maxAudio ?? 4;
  const videos = /* @__PURE__ */ new Map();
  const audios = /* @__PURE__ */ new Map();
  for (const f of formats) {
    if (!f || !f.formatId) continue;
    if (f.isAudioOnly) {
      if (!f.acodec) continue;
      const key2 = (f.ext || "audio").toLowerCase();
      const prev2 = audios.get(key2);
      if (!prev2 || betterFormat(f, prev2)) audios.set(key2, f);
      continue;
    }
    if (!f.vcodec) continue;
    const height = heightOf(f.resolution);
    const key = height ? `h${height}` : (f.resolution || f.ext || "v").toLowerCase();
    const prev = videos.get(key);
    if (!prev || betterFormat(f, prev.f)) videos.set(key, { f, height });
  }
  const videoRows = [...videos.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || score(b.f) - score(a.f)).slice(0, maxVideo).map((entry, i) => ({
    formatId: entry.f.formatId,
    kind: "video",
    label: entry.height ? `${entry.height}p` : entry.f.resolution || entry.f.ext.toUpperCase(),
    detail: videoDetail(entry.f),
    sizeBytes: entry.f.sizeBytes ?? null,
    best: i === 0
  }));
  const audioRows = [...audios.values()].sort((a, b) => score(b) - score(a)).slice(0, maxAudio).map((f, i) => ({
    formatId: f.formatId,
    kind: "audio",
    label: f.ext.toUpperCase(),
    detail: audioDetail(f),
    sizeBytes: f.sizeBytes ?? null,
    best: i === 0
  }));
  return [...videoRows, ...audioRows];
}
function extOf(url) {
  try {
    const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(new URL(url).pathname + (new URL(url).search || ""));
    return m ? m[1].toUpperCase() : "";
  } catch {
    return "";
  }
}
function mimeExt(mime) {
  if (!mime) return "";
  if (/mpegurl/i.test(mime)) return "HLS";
  if (/dash\+xml/i.test(mime)) return "DASH";
  const m = /\/([a-z0-9.+-]+)/i.exec(mime);
  if (!m) return "";
  return m[1].split(/[.+-]/)[0].toUpperCase() || m[1].toUpperCase();
}
function looksAudioUrl(url, mime) {
  if (mime && /^audio\//i.test(mime)) return true;
  return /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(url);
}
function looksAudio(media, url, mime) {
  if (media.kind === "audio") return true;
  return looksAudioUrl(url, mime);
}
var KNOWN_HEIGHTS = [2160, 1440, 1080, 900, 720, 480, 360, 240];
function qualityLabel(label, url, mime) {
  const raw = (label || "").trim();
  const fromLabel = /(\d{3,4})\s*[pP]\b/.exec(raw);
  if (fromLabel) return `${fromLabel[1]}p`;
  const fromSize = /(\d{3,4})\s*[x×]\s*(\d{3,4})/.exec(raw);
  if (fromSize) return `${Math.min(parseInt(fromSize[1], 10), parseInt(fromSize[2], 10))}p`;
  const fromUrl = /(\d{3,4})\s*[pP](?:[^\d]|$)/.exec(url);
  if (fromUrl) return `${fromUrl[1]}p`;
  for (const h of KNOWN_HEIGHTS) {
    if (new RegExp(`[^\\d]${h}[^\\d]`).test(url)) return `${h}p`;
  }
  if (raw && raw.length <= 16) return raw;
  if (looksAudioUrl(url, mime)) return "Ses";
  return "Video";
}
function rankOf(label) {
  const m = /(\d{3,4})p/.exec(label);
  return m ? parseInt(m[1], 10) : 0;
}
function formatsFromSources(media, opts = {}) {
  const maxVideo = opts.maxVideo ?? 6;
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  const sources = (media.sources || []).filter((s) => s && /^https?:\/\//i.test(s.url || ""));
  let index = 0;
  for (const s of sources) {
    const key = s.url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = looksAudio(media, s.url, s.mime) ? "audio" : "video";
    const label = qualityLabel(s.label, s.url, s.mime);
    const detail = [
      mimeExt(s.mime) || extOf(s.url),
      s.label && s.label.length <= 20 && s.label !== label ? s.label : ""
    ].filter(Boolean).join(" \xB7 ");
    rows.push({
      formatId: `src:${index++}`,
      kind,
      label,
      detail: detail || void 0,
      url: s.url,
      best: false
    });
  }
  const videoRows = rows.filter((r) => r.kind === "video").sort((a, b) => rankOf(b.label) - rankOf(a.label)).slice(0, maxVideo);
  const audioRows = rows.filter((r) => r.kind === "audio");
  if (videoRows.length === 0 && media.kind === "video") {
    videoRows.push({
      formatId: "direct",
      kind: "video",
      label: "Video",
      labelKey: "origVideo",
      detail: extOf(media.url) || void 0,
      url: /^https?:\/\//i.test(media.url) ? media.url : void 0,
      best: true
    });
  } else if (videoRows.length > 0) {
    videoRows[0].best = true;
  }
  if (media.kind === "audio" && audioRows.length === 0) {
    audioRows.push({
      formatId: "direct",
      kind: "audio",
      label: extOf(media.url) || "Ses",
      labelKey: "origAudio",
      url: /^https?:\/\//i.test(media.url) ? media.url : void 0,
      best: true
    });
  } else if (audioRows.length > 0) {
    audioRows[0].best = true;
  }
  if (opts.audioExtract && media.kind !== "audio") {
    audioRows.push({
      formatId: "audio:mp3",
      kind: "audio",
      label: "MP3",
      labelKey: "audioMp3",
      best: audioRows.length === 0
    });
  }
  return [...videoRows, ...audioRows].slice(0, 10);
}
export {
  classifyProbeError,
  formatsFromProbe,
  formatsFromSources,
  heightOf,
  isGenericPage,
  isStreamAddress,
  probeFirstTarget,
  qualityLabel
};
