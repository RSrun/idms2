'use strict'

/**
 * IDMS içerik betiği
 *
 *  1. Oynayan / üzerine gelinen video-ses öğesini bulur ve üzerine küçük bir
 *     "IDMS" rozeti çizer. Rozet ve kalite kartı sayfanın içindedir (gölge
 *     DOM); ayrı bir masaüstü penceresi yoktur, panel yalnızca bu sekmede yaşar.
 *  2. Bilinen dosya uzantılı bağlantılara (ve `download` öznitelikli bağlantılara)
 *     tıklamayı yakalar, sayfayı terk etmeden IDMS'e gönderir.
 *  3. Kısa bir sayfa içi bildirim gösterir.
 *
 * Kalite listesi ve indirme uygulamadan gelir: arka plan betiği (`background.js`)
 * üzerinden IDMS köprüsüne sorulur.
 */
;(() => {
  if (window.top !== window || window.__idmsContentLoaded) return
  window.__idmsContentLoaded = true
  try {
    document.documentElement.setAttribute('data-idms-ready', '1')
  } catch {
    /* belge henüz hazır değil */
  }

  const api = typeof browser !== 'undefined' ? browser : chrome

  const EXTRACTOR_HOST =
    /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com|vimeo\.com|reddit\.com|dailymotion\.com|twitch\.tv|soundcloud\.com|pinterest\.(?:com|co\.[a-z]{2}|[a-z]{2})|pin\.it|vk\.com|vkvideo\.ru|bilibili\.com|b23\.tv|kick\.com)$/i

  const DOWNLOAD_EXT =
    /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|msix|dmg|pkg|deb|rpm|apk|appx|pdf|docx?|xlsx?|pptx?|odt|ods|epub|torrent|mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus|wma|mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|m3u8|mpd)(?:[?#].*)?$/i

  const MEDIA_EXT =
    /\.(mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus|wma|mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|m3u8|mpd)(?:[?#].*)?$/i

  const STREAM_EXT = /\.(m3u8|mpd)(?:[?#].*)?$/i

  /**
   * Tek bir video/gönderi adresi deseni. Akış (blob:) oynatan sayfalarda
   * yt-dlp sayfa kökünü çözemez; videonun yakınındaki gerçek gönderi
   * bağlantısı (Instagram /p/, /reel/ ya da /reels/{kod}/, X /status/,
   * TikTok /video/… ) aranır. `/reels/audio/…` bir ses listesidir.
   */
  const POST_PATH =
    /\/(?:p|reel|tv)\/[A-Za-z0-9_-]{5,}|\/reels\/(?!(?:audio|highlights|saved|liked)(?:\/|$))[A-Za-z0-9_-]{5,}|\/status\/\d+|\/video\/\d+|\/videos?\/\d+|\/shorts\/[A-Za-z0-9_-]{5,}|\/embed\/[A-Za-z0-9_-]{5,}|\/clip\/[A-Za-z0-9_-]{4,}|\/comments\/[A-Za-z0-9]{4,}|\/watch\/?\?[^#]*\bv=\d+/i

  // -------------------------------------------------------------------------
  // Yardımcılar
  // -------------------------------------------------------------------------

  const send = (msg) => {
    try {
      api.runtime.sendMessage(msg)
    } catch {
      /* eklenti güncellenmiş / bağlam kapanmış */
    }
  }

  /** Arka plana sorar ve yanıtı bekler (yanıt yoksa null). */
  const ask = (msg) =>
    new Promise((resolve) => {
      try {
        const ret = api.runtime.sendMessage(msg)
        if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve(null))
        else resolve(ret === undefined ? null : ret)
      } catch {
        resolve(null)
      }
    })

  const absolute = (url) => {
    if (!url) return ''
    try {
      return new URL(url, location.href).href
    } catch {
      return url
    }
  }

  const sourceOf = (el) => {
    const raw = el.currentSrc || el.src || ''
    if (raw) return absolute(raw)
    // <source> alt öğeleri (currentSrc genelde doludur, yine de bak)
    const src = el.querySelector('source[src]')
    return src ? absolute(src.getAttribute('src')) : ''
  }

  const isPlaying = (el) => !!el && !el.paused && !el.ended

  /**
   * Gölge DOM (shadow root) sınırını aşan üst öğe: Reddit'in
   * `<shreddit-player>` gibi oynatıcıları videoyu açık bir gölge kökünde
   * tutar; `parentElement` orada biter, o yüzden kökün sahibine geçilir.
   */
  function composedParent(el) {
    if (el.parentElement) return el.parentElement
    const root = el.getRootNode()
    return root instanceof ShadowRoot ? root.host : null
  }

  /**
   * Olayın içinden gerçek medya öğesini bulur. Gölge DOM'daki videonun
   * olayları belgeye "shreddit-player" gibi bir kabuk olarak ulaşır;
   * `composedPath()` gölge kökü açıksa asıl `<video>` öğesini verir.
   */
  function mediaFromEvent(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : []
    for (const node of path) {
      if (node instanceof HTMLMediaElement) return node
    }
    const target = ev.target
    if (target instanceof Element) {
      const found = target.closest('video, audio')
      if (found instanceof HTMLMediaElement) return found
      for (const el of target.querySelectorAll('video, audio')) {
        if (el instanceof HTMLMediaElement) return el
      }
    }
    return null
  }

  /**
   * Belgedeki ve açık gölge köklerindeki tüm medya öğeleri. Reddit gibi
   * sitelerde video belge ağacında görünmez, bu yüzden kökler gezilir.
   */
  function allMedia() {
    const out = []
    const walk = (root, depth) => {
      if (!root || depth > 4) return
      for (const el of root.querySelectorAll('video, audio')) {
        if (el instanceof HTMLMediaElement) out.push(el)
      }
      let hosts = 0
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue
        if (++hosts > 600) break
        walk(el.shadowRoot, depth + 1)
      }
    }
    walk(document, 0)
    return out
  }

  function keyOf(el, url) {
    return `${location.href.split('#')[0]}|${url || el.tagName.toLowerCase()}|${el.id || ''}`.slice(0, 2000)
  }

  /** Medyanın görünüm alanında kalan parçası (CSS px). */
  function visiblePart(el) {
    const r = el.getBoundingClientRect()
    return {
      left: Math.max(0, r.left),
      right: Math.min(window.innerWidth, r.right),
      top: Math.max(0, r.top),
      bottom: Math.min(window.innerHeight, r.bottom)
    }
  }

  /** Panel için yeterli görünür video alanı var mı? */
  function onScreen(el) {
    const p = visiblePart(el)
    return p.right - p.left >= 80 && p.bottom - p.top >= 48
  }

  /**
   * Oynatıcının sunduğu alternatif dosyalar (<source> etiketleri). Panelde
   * IDM gibi "1080p / 720p / ses" listesi çıkarmak için kullanılır.
   */
  function sourcesOf(el) {
    const out = []
    const push = (raw, mime, label) => {
      const url = absolute(raw)
      if (!url || !/^https?:/i.test(url)) return
      if (out.some((s) => s.url === url)) return
      out.push({
        url,
        mime: (mime || '').slice(0, 80),
        label: (label || '').slice(0, 40)
      })
    }
    push(
      el.getAttribute('src'),
      el.getAttribute('type'),
      el.getAttribute('label') ||
        el.getAttribute('data-quality') ||
        el.getAttribute('data-res')
    )
    for (const s of el.querySelectorAll('source')) {
      push(
        s.getAttribute('src') || s.getAttribute('data-src'),
        s.getAttribute('type'),
        s.getAttribute('label') ||
          s.getAttribute('size') ||
          s.getAttribute('data-quality') ||
          s.getAttribute('data-res') ||
          s.getAttribute('title')
      )
    }
    return out.slice(0, 8)
  }

  /**
   * Videonun bulunduğu gönderi/video sayfasının adresi.
   *
   * Instagram akışı, X zaman tüneli gibi sayfalarda oynatıcı `blob:`
   * kullanır ve sayfa adresi tek bir video değildir; yt-dlp böyle bir adresi
   * çözemez. Video öğesinden yukarı doğru en fazla 12 ata içinde gönderi
   * bağlantısı aranır; bulunamazsa boş döner (panel kısa bir yönlendirme
   * gösterir).
   */
  function postUrlOf(el) {
    const here = location.href.split('#')[0]
    try {
      const u = new URL(here)
      if (POST_PATH.test(u.pathname + u.search)) return here
    } catch {
      /* geçersiz adres */
    }

    let node = composedParent(el)
    for (let depth = 0; depth < 12 && node && node !== document.body; depth++) {
      const links = node.querySelectorAll('a[href]')
      if (links.length > 120) break
      for (const a of links) {
        let target
        try {
          target = new URL(a.getAttribute('href'), location.href)
        } catch {
          continue
        }
        if (target.protocol !== 'https:' && target.protocol !== 'http:') continue
        if (target.hostname !== location.hostname) continue
        if (!POST_PATH.test(target.pathname + target.search)) continue
        return target.href.split('#')[0]
      }
      node = composedParent(node)
    }
    return ''
  }

  /**
   * Oynatıcının ağdan aldığı HLS/DASH manifesti (`.m3u8` / `.mpd`).
   *
   * Reddit gibi sitelerde oynatıcı tek bir `<source>` gösterir; kaliteler ve
   * ayrı ses akışı manifestte listelenir. Açık bir kaynak yoksa sayfanın
   * kaynak zamanlaması taranır: oynatıcı manifesti kendisi indirmiştir.
   * Akış/akış sayfalarında başka videoların manifestleri de bulunabildiği
   * için yalnızca bu videonun kaynağıyla aynı adı taşıyan manifest kabul
   * edilir (v.redd.it/<kimlik>/DASH_720.mp4 ↔ HLSPlaylist.m3u8 gibi).
   */
  function manifestOf(el) {
    for (const s of sourcesOf(el)) {
      if (STREAM_EXT.test(s.url)) return s.url
    }
    const keys = new Set()
    const addKey = (raw) => {
      const url = absolute(raw)
      if (!/^https?:/i.test(url)) return
      try {
        const u = new URL(url)
        const first = u.pathname.split('/').filter(Boolean)[0] || ''
        if (first) keys.add(`${u.hostname}/${first}`)
      } catch {
        /* geçersiz adres */
      }
    }
    for (const s of sourcesOf(el)) addKey(s.url)
    addKey(el.currentSrc || el.src)
    if (!keys.size) return ''
    const baseDomain = (host) => host.split('.').slice(-2).join('.')
    const sameDomain = (host) => [...keys].some((k) => baseDomain(k.split('/')[0]) === baseDomain(host))
    // Tek bir gönderi sayfasında (…/comments/…, /reel/…) manifest bu videoya
    // aittir; kaynak CDN'i farklı alt alan adında olabilir (v.redd.it ↔
    // packaged-media.redd.it). Akış sayfalarında yalnızca birebir eşleşme.
    const onPost = POST_PATH.test(location.pathname + location.search)
    try {
      const entries = performance.getEntriesByType('resource')
      for (let i = entries.length - 1, seen = 0; i >= 0 && seen < 600; i--, seen++) {
        const url = entries[i].name
        if (!url || !STREAM_EXT.test(url)) continue
        try {
          const u = new URL(url)
          const first = u.pathname.split('/').filter(Boolean)[0] || ''
          if (keys.has(`${u.hostname}/${first}`)) return url.split('#')[0]
          if (onPost && sameDomain(u.hostname)) return url.split('#')[0]
        } catch {
          /* geçersiz adres */
        }
      }
    } catch {
      /* kaynak zamanlaması yok */
    }
    return ''
  }

  function mediaInfo(el, url) {
    return {
      url,
      pageUrl: postUrlOf(el) || location.href,
      title: el.title || el.getAttribute('aria-label') || document.title || url,
      pageTitle: document.title,
      kind: el.tagName === 'AUDIO' ? 'audio' : 'video',
      duration: Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null,
      direct: /^https?:/i.test(url) && !STREAM_EXT.test(url),
      needsExtractor: EXTRACTOR_HOST.test(location.hostname),
      sources: sourcesOf(el),
      manifest: manifestOf(el)
    }
  }

  // -------------------------------------------------------------------------
  // Sayfa içi yüzen panel (gölge DOM)
  // -------------------------------------------------------------------------

  const HOST_ID = 'idms-float-host'
  const STYLES = `
    * { box-sizing: border-box; }
    .panel {
      position: relative; display: inline-block;
      font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
      direction: ltr; text-align: left; color: #17202f;
      -webkit-user-select: none; user-select: none; cursor: default;
      pointer-events: auto;
    }
    .panel[hidden] { display: none !important; }

    /* ---------- Kapalı hâl: küçük IDMS rozeti ---------- */
    .pill {
      display: inline-flex; align-items: center; gap: 5px;
      height: 30px; padding: 0 10px 0 9px;
      border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 9px;
      background: linear-gradient(180deg, #1a7bf0 0%, #0a5ed0 100%);
      color: #fff; font: 600 12px/1 'Segoe UI', system-ui, sans-serif;
      letter-spacing: 0.2px;
      box-shadow: 0 4px 14px rgba(6, 24, 60, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.25);
      cursor: pointer; padding-block: 0; margin: 0;
      transition: transform 0.12s ease, box-shadow 0.15s ease, filter 0.15s ease;
    }
    .pill[hidden] { display: none !important; }
    .pill:hover {
      filter: brightness(1.08); transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(6, 24, 60, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.3);
    }
    .pill:active { transform: none; }
    .pill .mark { font: 800 11.5px/1 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.5px; }
    .pill svg {
      fill: none; stroke: currentColor; stroke-width: 2.4;
      stroke-linecap: round; stroke-linejoin: round; opacity: 0.95;
    }

    /* ---------- Açık hâl: indirme kartı ---------- */
    .card {
      position: relative; display: flex; flex-direction: column;
      width: 348px; max-width: calc(100vw - 24px); max-height: min(360px, calc(100vh - 24px));
      border: 1px solid #b9bfcc; border-radius: 9px;
      background: linear-gradient(180deg, #fbfcfe 0%, #eef1f7 100%);
      color: #17202f;
      box-shadow: 0 14px 40px rgba(8, 18, 40, 0.42), 0 2px 6px rgba(8, 18, 40, 0.22);
      overflow: hidden; animation: idms-pop 0.12s ease-out;
    }
    .card[hidden] { display: none !important; }
    @keyframes idms-pop {
      from { opacity: 0; transform: translateY(-4px) scale(0.98); }
      to { opacity: 1; transform: none; }
    }

    .head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
      height: 38px; padding: 0 8px 0 10px; border-bottom: 1px solid #dde2ec;
    }
    .logo {
      flex: 0 0 auto; padding: 4px 6px; border-radius: 5px;
      background: linear-gradient(180deg, #1a7bf0, #0a5ed0); color: #fff;
      font: 800 10px/1 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.3px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3);
    }
    .titles { flex: 1 1 auto; min-width: 0; }
    .title {
      font: 600 12.5px/1.25 'Segoe UI', system-ui, sans-serif; color: #111a28;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .meta {
      margin-top: 1px; font: 10.5px/1.25 'Segoe UI', system-ui, sans-serif;
      color: #64708a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .icon {
      flex: 0 0 auto; width: 19px; height: 19px; padding: 0;
      border: 1px solid transparent; border-radius: 4px; background: transparent;
      color: #5a6579; font: 700 11px/1 'Segoe UI', sans-serif; cursor: pointer;
    }
    .icon:hover { background: #fdeaea; border-color: #f0c4c4; color: #c02626; }

    /* ---------- Kalite / ses listesi ---------- */
    .list {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
      padding: 5px 6px;
    }
    .list::-webkit-scrollbar { width: 6px; }
    .list::-webkit-scrollbar-thumb { background: #c3cddd; border-radius: 3px; }
    .list::-webkit-scrollbar-thumb:hover { background: #a9b7cc; }
    .sec {
      display: flex; align-items: center; gap: 5px; height: 15px; padding: 0 4px;
      font: 700 9.5px/15px 'Segoe UI', system-ui, sans-serif;
      letter-spacing: 0.7px; text-transform: uppercase; color: #7b869c;
    }
    .sec-count { font-size: 9px; font-weight: 600; color: #9aa5b8; }
    .row {
      display: flex; align-items: center; gap: 6px; width: 100%; height: 24px;
      padding: 0 6px 0 7px; border: 1px solid transparent; border-radius: 5px;
      background: transparent; color: #1b2536;
      font: 500 11.5px/1 'Segoe UI', system-ui, sans-serif; text-align: left;
      cursor: pointer; margin: 0;
    }
    .row:hover { background: #e7f0fd; border-color: #c9dcf9; }
    .row:active { background: #dbe9fc; }
    .row.best { background: linear-gradient(180deg, #f4f9ff, #e9f2fe); border-color: #d3e2fa; }
    .row.best .q { color: #0a5ed0; }
    .row .q {
      flex: 0 0 auto; font-weight: 700; letter-spacing: 0.2px; white-space: nowrap;
    }
    .row .detail {
      flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-size: 10.5px; font-weight: 400; color: #66718a;
    }
    .row .size {
      flex: 0 0 auto; font: 600 10.5px/1 'Consolas', 'Segoe UI', monospace; color: #55607a;
    }
    .row[disabled] { opacity: 0.55; cursor: default; }
    .note {
      display: flex; align-items: flex-start; gap: 6px; min-height: 24px;
      padding: 4px 7px; color: #6b768c;
      font: 400 11px/1.35 'Segoe UI', system-ui, sans-serif;
    }
    .note-text {
      display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical;
      -webkit-line-clamp: 3; overflow-wrap: anywhere;
    }
    .spin {
      flex: 0 0 auto; width: 10px; height: 10px; margin-top: 3px;
      border: 2px solid #c6d6ee; border-top-color: #1a7bf0; border-radius: 50%;
      animation: idms-spin 0.7s linear infinite;
    }
    @keyframes idms-spin { to { transform: rotate(360deg); } }

    .foot {
      flex: 0 0 auto; display: flex; align-items: center; gap: 4px;
      height: 27px; padding: 0 8px;
    }
    .grow { flex: 1 1 auto; }
    .link {
      border: none; background: transparent; padding: 3px 5px; border-radius: 4px;
      color: #0a5ed0; font: 600 11px/1 'Segoe UI', system-ui, sans-serif; cursor: pointer;
    }
    .link:hover { background: #e3edfc; text-decoration: underline; }

    .status {
      position: absolute; left: 7px; right: 7px; bottom: 5px; padding: 5px 8px;
      border-radius: 5px; font: 11.5px/1.35 'Segoe UI', system-ui, sans-serif;
      background: #e4eefc; color: #0a4aa8; border: 1px solid #c8dcf8;
      box-shadow: 0 2px 8px rgba(8, 18, 40, 0.18);
    }
    .status[hidden] { display: none !important; }
    .status.error { background: #fdeaea; border-color: #f2c6c6; color: #b02020; }
    .status.success { background: #e2f6ec; border-color: #bfe7cf; color: #14743f; }
  `

  const TEMPLATE = `
    <style>${STYLES}</style>
    <div class="panel" hidden>
      <button type="button" class="pill" title="IDMS">
        <span class="mark">IDMS</span>
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" />
        </svg>
      </button>
      <div class="card" hidden>
        <div class="head">
          <span class="logo">IDMS</span>
          <div class="titles">
            <div class="title"></div>
            <div class="meta"></div>
          </div>
          <button type="button" class="icon close" aria-label="Kapat" title="Kapat">✕</button>
        </div>
        <div class="list"></div>
        <div class="foot">
          <button type="button" class="link formats"></button>
          <span class="grow"></span>
          <button type="button" class="link open"></button>
        </div>
        <div class="status" hidden></div>
      </div>
    </div>
  `

  const LANG = {
    tr: {
      videoSec: 'Video',
      audioSec: 'Ses',
      loading: 'Kaliteler alınıyor…',
      noFormats: 'Kalite listesi yok',
      origVideo: 'Özgün video',
      origAudio: 'Özgün ses',
      audioMp3: 'Sadece ses (MP3)',
      best: 'en iyi',
      formats: 'Formatlar…',
      open: "IDMS'i aç",
      close: 'Kapat',
      added: 'IDMS kuyruğuna eklendi',
      videoKind: 'Video',
      audioKind: 'Ses',
      unsupported: 'Bu adres doğrudan indirilemiyor'
    },
    en: {
      videoSec: 'Video',
      audioSec: 'Audio',
      loading: 'Reading qualities…',
      noFormats: 'No quality list',
      origVideo: 'Original video',
      origAudio: 'Original audio',
      audioMp3: 'Audio only (MP3)',
      best: 'best',
      formats: 'Formats…',
      open: 'Open IDMS',
      close: 'Close',
      added: 'Queued in IDMS',
      videoKind: 'Video',
      audioKind: 'Audio',
      unsupported: 'This address cannot be downloaded directly'
    }
  }

  let panelHost = null
  let shadow = null
  let panelEl = null
  let pillEl = null
  let cardEl = null
  let headEl = null
  let titleEl = null
  let metaEl = null
  let listEl = null
  let statusEl = null
  let footEl = null
  let closeEl = null
  let formatsEl = null
  let openEl = null

  let media = null
  /** Paneli videonun sağ üst köşesine bağlayan gerçek medya öğesi */
  let anchorEl = null
  let key = ''
  let formats = []
  let formatsState = 'idle'
  let formatsNote = ''
  let lang = 'tr'
  let expanded = false
  let visible = false
  /** Kaydırma sırasında panel gizlenir; kaydırma durunca geri gelir. */
  let scrollHidden = false
  let scrollTimer = 0
  let dismissedKey = ''
  let pendingHide = false
  let overlayHover = false
  let statusTimer = 0
  let busy = false
  let panelEnabled = true
  /**
   * IDMS köprüsü kullanılabilir mi (eşleşmiş + etkin)? Bağlantı tıklaması
   * yakalanmadan önce bakılır: hazır değilken sayfanın indirmesi engellenmez,
   * böylece dosya sessizce kaybolmaz. Depolama okunana kadar `true` kabul
   * edilir; yanıt başarısız olursa tıklama yine de tarayıcıya bırakılır.
   */
  let integrationReady = true

  /** Kalite listeleri: aynı video tekrar açılınca uygulamaya yeniden sorulmaz. */
  const formatsCache = new Map()

  const t = (name) => (LANG[lang] && LANG[lang][name]) || LANG.tr[name] || name

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }

  function duration(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return ''
    const s = Math.round(sec)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const rs = s % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`
      : `${m}:${String(rs).padStart(2, '0')}`
  }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = n
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024
      i++
    }
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
  }

  /**
   * Panel gölge kökünü kurar. Sayfanın CSS'i içine işlemesin diye tüm stiller
   * gölge kökündedir; konum/katman bilgisi ana öğede satır içi `!important`.
   */
  function ensurePanel() {
    if (panelHost && panelHost.isConnected) return
    let existing = document.getElementById(HOST_ID)
    if (!existing) {
      existing = document.createElement('div')
      existing.id = HOST_ID
    }
    panelHost = existing
    panelHost.setAttribute('data-idms-panel', '1')
    panelHost.style.cssText =
      'all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important;' +
      ' right: auto !important; display: block !important; width: auto !important; height: auto !important;' +
      ' z-index: 2147483647 !important; pointer-events: none !important; direction: ltr !important;' +
      ' margin: 0 !important; padding: 0 !important; border: 0 !important; background: none !important;'
    mount()

    if (!panelHost.shadowRoot) panelHost.attachShadow({ mode: 'open' })
    shadow = panelHost.shadowRoot
    shadow.innerHTML = TEMPLATE

    panelEl = shadow.querySelector('.panel')
    pillEl = shadow.querySelector('.pill')
    cardEl = shadow.querySelector('.card')
    headEl = shadow.querySelector('.head')
    titleEl = shadow.querySelector('.title')
    metaEl = shadow.querySelector('.meta')
    listEl = shadow.querySelector('.list')
    statusEl = shadow.querySelector('.status')
    footEl = shadow.querySelector('.foot')
    closeEl = shadow.querySelector('.close')
    formatsEl = shadow.querySelector('.formats')
    openEl = shadow.querySelector('.open')
    bindPanel()
  }

  /** Tam ekranda panelin görünmesi için doğru kaba yerleştirir. */
  function mount() {
    if (!panelHost) return
    let target = document.fullscreenElement || document.documentElement
    // Doğrudan <video> tam ekrana alınmışsa çocukları çizilmez; kabuğuna çık.
    if (target instanceof HTMLMediaElement) {
      target = target.parentElement || document.documentElement
    }
    try {
      if (target && panelHost.parentNode !== target) target.appendChild(panelHost)
    } catch {
      /* belge hazır değil */
    }
  }

  function bindPanel() {
    pillEl.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (media) setExpanded(true)
    })

    headEl.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (expanded) setExpanded(false)
    })

    closeEl.addEventListener('click', (ev) => {
      ev.stopPropagation()
      dismissedKey = key
      setExpanded(false)
      hidePanel(false)
    })

    formatsEl.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (!media) return
      void ask({ type: 'float-action', action: 'formats', key, media }).then((res) => {
        if (res && res.ok === false) showStatus(res.error || res.message || t('unsupported'), 'error')
      })
    })

    openEl.addEventListener('click', (ev) => {
      ev.stopPropagation()
      send({ type: 'open-app' })
    })

    listEl.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const target = ev.target instanceof Element ? ev.target.closest('.row') : null
      if (!target || target.disabled) return
      void downloadRow(target)
    })

    // Panel tıklamaları sayfanın kendi kısayollarına (boşluk = oynat/duraklat)
    // gitmesin; sayfaya "tıklama" olarak sızmasın.
    panelEl.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    panelEl.addEventListener('click', (ev) => ev.stopPropagation())
    panelEl.addEventListener('pointerenter', () => {
      overlayHover = true
      clearTimeout(hideTimer)
      hideTimer = 0
    })
    panelEl.addEventListener('pointerleave', () => {
      overlayHover = false
      if (active && !isPlaying(active)) scheduleHide(1200)
    })
  }

  /* ---- görünüm ---- */

  function render() {
    if (!panelEl) return
    if (!media || !visible) {
      panelEl.hidden = true
      return
    }
    panelEl.hidden = scrollHidden

    formatsEl.textContent = t('formats')
    openEl.textContent = t('open')
    closeEl.title = t('close')
    closeEl.setAttribute('aria-label', t('close'))

    titleEl.textContent = media.title || media.pageTitle || hostOf(media.pageUrl) || 'IDMS'
    const bits = []
    const host = hostOf(media.pageUrl || media.url)
    if (host) bits.push(host)
    bits.push(media.kind === 'audio' ? t('audioKind') : t('videoKind'))
    const d = duration(media.duration)
    if (d) bits.push(d)
    metaEl.textContent = bits.join(' · ')

    renderList()
    applyExpandedVisual()
  }

  function noteRow(text, spinner) {
    const row = document.createElement('div')
    row.className = spinner ? 'note busy' : 'note'
    if (spinner) {
      const spin = document.createElement('span')
      spin.className = 'spin'
      row.appendChild(spin)
    }
    const label = document.createElement('span')
    label.className = 'note-text'
    label.textContent = text
    row.appendChild(label)
    return row
  }

  function formatLabel(f) {
    if (f.labelKey) return t(f.labelKey)
    return f.label || 'Video'
  }

  function formatRow(f) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = f.best ? 'row best' : 'row'
    row.dataset.formatId = f.formatId
    row.dataset.kind = f.kind
    const label = formatLabel(f)
    row.title = [label, f.detail, f.sizeBytes ? formatBytes(f.sizeBytes) : '']
      .filter(Boolean)
      .join(' · ')

    const q = document.createElement('span')
    q.className = 'q'
    q.textContent = label
    row.appendChild(q)

    if (f.detail) {
      const detail = document.createElement('span')
      detail.className = 'detail'
      detail.textContent = f.detail
      row.appendChild(detail)
    }
    if (typeof f.sizeBytes === 'number' && f.sizeBytes > 0) {
      const size = document.createElement('span')
      size.className = 'size'
      size.textContent = formatBytes(f.sizeBytes)
      row.appendChild(size)
    }
    return row
  }

  function buildList(target) {
    const root = target || listEl
    root.textContent = ''
    if (formatsState === 'loading' || formatsState === 'idle') {
      root.appendChild(noteRow(t('loading'), true))
      return
    }
    if (formatsState === 'error' || formatsState === 'empty' || formats.length === 0) {
      root.appendChild(noteRow(formatsNote || t('noFormats'), false))
      return
    }
    for (const kind of ['video', 'audio']) {
      const rows = formats.filter((f) => f.kind === kind)
      if (!rows.length) continue
      const sec = document.createElement('div')
      sec.className = 'sec'
      sec.textContent = kind === 'video' ? t('videoSec') : t('audioSec')
      const count = document.createElement('span')
      count.className = 'sec-count'
      count.textContent = String(rows.length)
      sec.appendChild(count)
      root.appendChild(sec)
      for (const f of rows) root.appendChild(formatRow(f))
    }
  }

  function renderList() {
    if (!listEl) return
    buildList(listEl)
  }

  function applyExpandedVisual() {
    if (!panelEl) return
    cardEl.hidden = !expanded
    pillEl.hidden = expanded
  }

  function setExpanded(next) {
    expanded = next
    if (expanded) {
      pendingHide = false
      loadFormats()
    }
    applyExpandedVisual()
    render()
    place()
    if (!expanded && pendingHide) hidePanel(false)
  }

  function showStatus(message, tone) {
    if (!message || !statusEl) return
    window.clearTimeout(statusTimer)
    statusEl.textContent = message
    statusEl.className = `status ${tone || 'info'}`
    statusEl.hidden = false
    footEl.style.display = 'none'
    statusTimer = window.setTimeout(() => {
      statusEl.hidden = true
      footEl.style.display = ''
    }, 6000)
  }

  function clearStatus() {
    if (!statusEl) return
    window.clearTimeout(statusTimer)
    statusEl.hidden = true
    footEl.style.display = ''
  }

  /* ---- konum: videonun sağ üst köşesi ---- */

  /**
   * Paneli videonun sağ üst köşesine yerleştirir. Panel videoyla birlikte
   * kayar (videonun bir parçası gibi durur); video görünümden çıkınca gizlenir.
   */
  function place() {
    if (!visible || !media || !panelEl || !panelHost) return
    const el = anchorEl
    if (!el || !el.isConnected || !onScreen(el)) {
      hidePanel(false)
      return
    }

    const view = visiblePart(el)
    // Açık kart videodan geniş olmasın: video darsa kart da daralır.
    if (expanded && cardEl) {
      const maxW = Math.min(348, Math.max(180, Math.round(view.right - view.left - 8)))
      cardEl.style.maxWidth = `${maxW}px`
    }
    const box = expanded ? cardEl : pillEl
    const w = box.offsetWidth
    const h = box.offsetHeight
    if (!w || !h) return

    const gap = 12
    // Sağ üst köşe: kart videodan genişse sağ kenara yaslanıp sola taşar.
    let x = view.right - w - gap
    if (x < view.left + 2) x = view.right - w - 2
    let y = view.top + gap
    // Video kısaysa panel video/ekran altından taşmasın.
    if (y + h > window.innerHeight - 4) y = window.innerHeight - h - 4

    x = Math.round(Math.max(4, x))
    y = Math.round(Math.max(4, y))
    panelHost.style.setProperty('left', `${x}px`, 'important')
    panelHost.style.setProperty('top', `${y}px`, 'important')
    panelHost.style.setProperty('right', 'auto', 'important')
  }

  /* ---- görünürlük ---- */

  function showFor(el) {
    if (!el || !el.isConnected || document.hidden || !panelEnabled) return
    ensurePanel()

    const url = sourceOf(el)
    const nextKey = keyOf(el, url)
    // ✕ ile kapatılan medya, sekme değişene ya da başka video açılana kadar
    // kendiliğinden geri gelmez.
    if (nextKey === dismissedKey) return

    const changed = nextKey !== key || !media
    key = nextKey
    anchorEl = el
    watchAnchor(el)
    media = mediaInfo(el, url)

    if (changed) {
      expanded = false
      pendingHide = false
      clearStatus()
      formats = []
      formatsState = 'idle'
      formatsNote = ''
      const cached = formatsCache.get(key)
      if (cached) {
        formats = cached.formats
        formatsState = cached.ok ? (formats.length ? 'ready' : 'empty') : 'error'
        formatsNote = cached.note || ''
      }
    }

    visible = true
    if (expanded) pendingHide = false
    render()
    mount()
    place()

    if (changed && !formatsCache.has(key)) loadFormats()
  }

  function hidePanel(force) {
    visible = false
    expanded = false
    pendingHide = false
    scrollHidden = false
    clearTimeout(scrollTimer)
    scrollTimer = 0
    clearStatus()
    if (panelEl) {
      applyExpandedVisual()
      panelEl.hidden = true
    }
    if (force) {
      media = null
      anchorEl = null
      key = ''
      watchedEl = null
      try {
        anchorObserver?.disconnect()
      } catch {
        /* yoksay */
      }
      formats = []
      formatsState = 'idle'
      formatsNote = ''
    }
  }

  function requestHide() {
    // Kart açıkken videonun durması kullanıcının elinden paneli çekmez;
    // gizleme isteği kart kapanınca uygulanır.
    if (expanded) {
      pendingHide = true
      return
    }
    hidePanel(false)
  }

  /* ---- kalite listesi ---- */

  function loadFormats() {
    if (!media || !panelEnabled || !key) return
    if (formatsState === 'loading') return
    const cached = formatsCache.get(key)
    if (cached) {
      formats = cached.formats
      formatsState = cached.ok ? (formats.length ? 'ready' : 'empty') : 'error'
      formatsNote = cached.note || ''
      render()
      return
    }
    formats = []
    formatsState = 'loading'
    formatsNote = ''
    render()

    const asked = key
    void ask({ type: 'float-formats', key, media }).then((res) => {
      if (key !== asked) return
      if (!res) {
        setFormats({ ok: false, formats: [], note: t('noFormats') })
        return
      }
      if (res.language === 'en' || res.language === 'tr') lang = res.language
      if (res.ok === undefined && !Array.isArray(res.formats)) {
        setFormats({ ok: false, formats: [], note: res.error || res.message || t('noFormats') })
        return
      }
      const result = {
        ok: !!res.ok,
        formats: Array.isArray(res.formats) ? res.formats : [],
        note: typeof res.note === 'string' ? res.note : ''
      }
      // Yalnızca başarılı listeler önbelleğe alınır: yeniden denemek mümkün olsun.
      if (result.ok) formatsCache.set(asked, result)
      setFormats(result)
    })
  }

  function setFormats(result) {
    formats = result.formats || []
    formatsState = result.ok ? (formats.length ? 'ready' : 'empty') : 'error'
    formatsNote = result.note || ''
    render()
    place()
  }

  async function downloadRow(row) {
    if (busy || !media) return
    busy = true
    row.disabled = true
    try {
      const res = await ask({
        type: 'float-download',
        key,
        media,
        kind: row.dataset.kind === 'audio' ? 'audio' : 'video',
        formatId: row.dataset.formatId || ''
      })
      if (res && res.ok) {
        showStatus(res.message || t('added'), 'success')
        window.setTimeout(() => hidePanel(false), 1800)
      } else {
        showStatus((res && (res.message || res.error)) || t('unsupported'), 'error')
      }
    } finally {
      busy = false
      row.disabled = false
    }
  }

  /* ---- ayar (yalnızca eşleşmiş ve açıkken görünür) ---- */

  function applyConfig(saved) {
    panelEnabled =
      saved &&
      saved.floatingPanel !== false &&
      saved.paired === true &&
      saved.enabled !== false
    if (saved && typeof saved.paired === 'boolean') {
      integrationReady = saved.paired === true && saved.enabled !== false
    }
    if (!panelEnabled) hidePanel(true)
  }

  function loadConfig() {
    try {
      const ret = api.storage.local.get({ floatingPanel: true, paired: false, enabled: true })
      if (ret && typeof ret.then === 'function') ret.then(applyConfig, () => {})
    } catch {
      /* storage yok */
    }
  }

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      if (changes.floatingPanel || changes.paired || changes.enabled) loadConfig()
    })
  } catch {
    /* storage olayları yok */
  }

  loadConfig()

  // -------------------------------------------------------------------------
  // Medya algılama
  // -------------------------------------------------------------------------

  let active = null
  let hovering = false
  let hideTimer = 0
  let lastScan = 0

  function activate(el, hovered) {
    if (!(el instanceof HTMLMediaElement)) return
    active = el
    if (hovered) hovering = true
    clearTimeout(hideTimer)
    hideTimer = 0
    showFor(el)
  }

  function scheduleHide(delay = 1400) {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = 0
      if (overlayHover) return
      if (active && isPlaying(active)) return
      if (hovering) return
      requestHide()
      if (active && !isPlaying(active)) active = null
    }, delay)
  }

  // Medya oynatma olayları (tüm sayfa, capture)
  document.addEventListener(
    'play',
    (ev) => {
      if (ev.target instanceof HTMLMediaElement) activate(ev.target, true)
    },
    true
  )
  document.addEventListener(
    'playing',
    (ev) => {
      if (ev.target instanceof HTMLMediaElement) activate(ev.target)
    },
    true
  )
  document.addEventListener(
    'pause',
    (ev) => {
      if (ev.target !== active) return
      if (overlayHover) return
      // Kullanıcı rozete ulaşabilsin diye kısa bir süre daha görünür kalır.
      scheduleHide(2600)
    },
    true
  )
  document.addEventListener(
    'ended',
    (ev) => {
      if (ev.target !== active) return
      active = null
      requestHide()
    },
    true
  )
  document.addEventListener(
    'emptied',
    (ev) => {
      if (ev.target !== active) return
      active = null
      requestHide()
    },
    true
  )

  // İşaretçi medya üzerindeyken (oynatılmasa da) panel görünür kalsın
  document.addEventListener(
    'pointerover',
    (ev) => {
      const mediaEl = mediaFromEvent(ev)
      if (!mediaEl) return
      hovering = true
      activate(mediaEl, true)
    },
    true
  )

  document.addEventListener(
    'pointerout',
    (ev) => {
      const mediaEl = mediaFromEvent(ev)
      if (!mediaEl) return
      const to = ev.relatedTarget
      if (to instanceof Node && mediaEl.contains(to)) return
      // İmleç panelin üzerine geçtiyse paneli kapatma.
      if (to instanceof Node && panelHost && (to === panelHost || panelHost.contains(to))) return
      hovering = false
      scheduleHide(1800)
    },
    true
  )

  // Panel videonun sağ üst köşesine bağlıdır: sayfa kaydırılınca videoyla
  // birlikte yer değiştirir, videonun köşesinden ayrılmaz.
  let placeQueued = false
  const reposition = () => {
    if (placeQueued) return
    placeQueued = true
    requestAnimationFrame(() => {
      placeQueued = false
      if (!active) return
      if (!visible) {
        if (isPlaying(active) || hovering || overlayHover) showFor(active)
        return
      }
      mount()
      place()
    })
  }
  window.addEventListener('scroll', reposition, { capture: true, passive: true })
  window.addEventListener('resize', reposition, { passive: true })
  document.addEventListener('fullscreenchange', () => setTimeout(reposition, 80), true)

  // Kaydırma sırasında panel gizlenir (videoyla birlikte kayarken göz takibi
  // olmasın); kaydırma durunca videonun sağ üst köşesinde geri gelir.
  const revealAfterScroll = () => {
    scrollTimer = 0
    if (!visible || !media || !panelEnabled) return
    // Duraklatılmış videoda kaydırma bitince panel kendiliğinden geri gelmesin;
    // oynatma/üzerine gelme/kart açıkken geri gelir.
    if (!expanded && !hovering && !overlayHover && !(anchorEl && isPlaying(anchorEl))) return
    scrollHidden = false
    render()
    mount()
    place()
  }
  window.addEventListener(
    'scroll',
    (ev) => {
      // Panelin kendi kalite listesini kaydırmak paneli gizlemesin.
      const target = ev.target
      if (
        panelHost &&
        target instanceof Node &&
        (target === panelHost ||
          panelHost.contains(target) ||
          (listEl && (target === listEl || listEl.contains(target))))
      ) {
        return
      }
      if (!visible) return
      scrollHidden = true
      if (panelEl) panelEl.hidden = true
      clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(revealAfterScroll, 400)
    },
    { capture: true, passive: true }
  )

  // Video boyutu değişince (pencere/tam ekran/düzen kayması) paneli yeniden hizala.
  let anchorObserver = null
  let watchedEl = null
  function watchAnchor(el) {
    if (!el || watchedEl === el) return
    watchedEl = el
    try {
      if (typeof ResizeObserver !== 'function') return
      if (!anchorObserver) anchorObserver = new ResizeObserver(() => reposition())
      anchorObserver.disconnect()
      anchorObserver.observe(el)
    } catch {
      /* ResizeObserver yok */
    }
  }

  setInterval(() => {
    if (document.hidden) return
    if (active && !active.isConnected) {
      active = null
      hidePanel(false)
    }
    if (!active) {
      // Gölge DOM'daki (Reddit vb.) autoplay videolar belge ağacında
      // görünmez ve play olayları belgeye ulaşmaz; ara sıra taranır.
      if (Date.now() - lastScan >= 2500) {
        lastScan = Date.now()
        scanPlaying()
      }
      return
    }
    // Video görünümden çıktıysa panel de görünmez; geri gelince yeniden çizilir.
    if (!onScreen(active)) {
      if (visible) hidePanel(false)
      return
    }
    // Sayfa kendi DOM'unu yenileyip panel düğümünü kaldırdıysa geri koy.
    if (visible && (!panelHost || !panelHost.isConnected)) {
      showFor(active)
      return
    }
    if (isPlaying(active) || hovering || overlayHover) {
      const current = keyOf(active, sourceOf(active))
      if (!visible || current !== key || !media) showFor(active)
      else place()
    }
  }, 1000)

  /**
   * Betik yüklendiğinde zaten oynayan (autoplay) medyayı da yakala; aksi
   * hâlde panel ancak bir play/pointerover olayından sonra görünürdü.
   * Gölge köklerdeki videolar için `allMedia()` kullanılır.
   */
  function scanPlaying() {
    if (active && isPlaying(active)) return
    const playing = []
    for (const el of allMedia()) {
      if (!isPlaying(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      playing.push({ el, area: r.width * r.height })
    }
    if (!playing.length) return
    playing.sort((a, b) => b.area - a.area)
    activate(playing[0].el, true)
  }

  scanPlaying()
  setTimeout(scanPlaying, 900)

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hidePanel(false)
      return
    }
    // Sekmeye dönünce panel 1 sn'lik taramayı beklemeden geri gelsin.
    if (active && (isPlaying(active) || hovering)) showFor(active)
    else scanPlaying()
  })
  window.addEventListener('pagehide', () => hidePanel(false))
  window.addEventListener('beforeunload', () => hidePanel(false))

  // -------------------------------------------------------------------------
  // Bağlantı tıklaması yakalama
  // -------------------------------------------------------------------------

  /**
   * Bildirim zamanlayıcısı burada tanımlanır: panel kurulumu bir sayfada hata
   * verip betiğin geri kalanını durdursa bile tıklama yakalama bildirimi
   * çalışabilsin (aşağıdaki `toast` bu değişkeni kullanır).
   */
  let toastTimer = 0

  /**
   * IDMS bağlantıyı alamadığında tarayıcının kendi indirmesini geri başlatır.
   * Tıklama `preventDefault()` ile durdurulduğu için, bu geri dönüş olmadan
   * dosya sessizce kaybolurdu (uygulama kapalı / eşleştirme geçersiz).
   */
  const restoring = new WeakSet()

  function restoreNavigation(anchor, href) {
    const target = (anchor.getAttribute('target') || '').toLowerCase()
    const download = anchor.getAttribute('download')
    try {
      if (download === null && target && target !== '_self') {
        window.open(href, target === '_blank' ? '_blank' : target, 'noopener')
        return
      }
      if (download === null) {
        location.assign(href)
        return
      }
      // `download` öznitelikli bağlantıda tarayıcının indirme davranışı korunur.
      const a = document.createElement('a')
      a.href = href
      a.rel = 'noopener'
      a.setAttribute('download', download || '')
      if (target) a.target = target
      a.style.display = 'none'
      restoring.add(a)
      ;(document.body || document.documentElement).appendChild(a)
      a.click()
      a.remove()
    } catch {
      /* geri dönüş başarısız: sayfa olduğu gibi kalır */
    }
  }

  /** Yakalama başarısız olduğunda kullanıcıya gösterilecek kısa neden. */
  function captureErrorText(res) {
    const message = String((res && (res.message || res.error)) || '')
    if (/eşleştir|geçersiz|token/i.test(message)) {
      return 'IDMS eşleştirmesi geçersiz — indirme tarayıcıya bırakıldı'
    }
    if (/çalışmıyor|kapalı|ulaş|bağlan/i.test(message)) {
      return 'IDMS çalışmıyor — indirme tarayıcıya bırakıldı'
    }
    return 'IDMS bağlantıyı alamadı — indirme tarayıcıya bırakıldı'
  }

  document.addEventListener(
    'click',
    (ev) => {
      if (ev.defaultPrevented || ev.button !== 0) return
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
      const target = ev.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      // Kendi geri dönüş tıklamamız tekrar yakalanmasın.
      if (restoring.has(anchor)) return

      const href = absolute(anchor.href)
      if (!/^https?:/i.test(href)) return

      const hasDownload = anchor.hasAttribute('download')
      if (!hasDownload && !DOWNLOAD_EXT.test(href)) return

      // Uygulama kapalı / eşleştirme yok: tıklamayı yutma, tarayıcı indirsin.
      if (!integrationReady) {
        toast('IDMS hazır değil — indirme tarayıcıya bırakıldı')
        return
      }

      // Sayfa içi çapa / aynı adres değilse yakala
      ev.preventDefault()
      ev.stopImmediatePropagation()

      const media = MEDIA_EXT.test(href)
      void ask({
        type: 'link-click',
        url: href,
        pageUrl: location.href,
        name: anchor.getAttribute('download') || '',
        media
      }).then((res) => {
        if (res && res.ok) {
          toast(media ? 'Medya IDMS kuyruğuna eklendi' : 'İndirme IDMS kuyruğuna eklendi')
          return
        }
        // IDMS alamadıysa dosya kaybolmasın: tarayıcı indirmesine geri dön.
        toast(captureErrorText(res))
        restoreNavigation(anchor, href)
      })
    },
    true
  )

  // -------------------------------------------------------------------------
  // Sayfa içi kısa bildirim
  // -------------------------------------------------------------------------

  function toast(text) {
    try {
      let host = document.getElementById('idms-toast-host')
      if (!host) {
        host = document.createElement('div')
        host.id = 'idms-toast-host'
        host.className = 'idms-toast-host'
        document.documentElement.appendChild(host)
      }
      const root = host.shadowRoot || host.attachShadow({ mode: 'open' })
      root.innerHTML = ''
      const box = document.createElement('div')
      box.className = 'idms-toast'
      const mark = document.createElement('span')
      mark.className = 'idms-toast-mark'
      mark.textContent = 'IDMS'
      const label = document.createElement('span')
      label.textContent = text
      box.append(mark, label)
      root.append(box)

      const style = root.getElementById('idms-toast-style') || document.createElement('style')
      style.id = 'idms-toast-style'
      style.textContent = `
        .idms-toast {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 13px; border-radius: 10px;
          background: #14171f; color: #e8edf7;
          font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          border: 1px solid #333a4a;
          box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
          animation: idms-in .16s ease-out;
        }
        .idms-toast-mark {
          font-weight: 800; letter-spacing: .4px; font-size: 11px;
          color: #8db8ff; border: 1px solid #2f4a74; border-radius: 6px;
          padding: 2px 5px; background: #1d2c47;
        }
        @keyframes idms-in { from { opacity: 0; transform: translateY(6px) } }
      `
      if (!style.parentNode) root.append(style)

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        try {
          root.innerHTML = ''
        } catch {
          /* yoksay */
        }
      }, 2600)
    } catch {
      /* bildirim gösterilemedi */
    }
  }
})()
