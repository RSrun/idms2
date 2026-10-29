'use strict'

/** Chrome `chrome.*` ve Firefox `browser.*` aynı Promise API'siyle kullanılır. */
const api = typeof browser !== 'undefined' ? browser : chrome

/**
 * IDMS tarayıcı eklentisi — arka plan (MV3 service worker / Firefox event page)
 *
 * Görevleri:
 *  1. Tarayıcı indirmelerini devralmak (api.downloads.onCreated → iptal → IDMS)
 *  2. Ağ gözetleme (webRequest) ile indirilebilir içerikleri toplamak
 *  3. Sağ tık menüsü ("IDMS ile indir": bağlantı / medya / görsel / sayfa)
 *  4. Sayfa içi yüzen panelin isteklerini (kalite listesi, indirme) uygulamaya
 *     iletmek. Panel içerik betiğinde çizilir; burada yalnızca köprü vardır.
 *
 * Uygulama köprüsü: http://127.0.0.1:9789-9798
 *  - POST /pair {code} → token (yalnızca eklenti kökenine)
 *  - POST /rpc  (X-IDMS-Token) → indirme, medya, aç, panel…
 *  - WS /?token=… → canlı durum/toast
 */

const APP_PORTS = Array.from({ length: 10 }, (_, i) => 9789 + i)

const DEFAULTS = {
  port: 9789,
  token: '',
  paired: false,
  enabled: true,
  takeOver: true,
  autoDetect: true,
  /** Sayfada çizilen yüzen panel (uygulama ayarına göre güncellenir) */
  floatingPanel: true,
  count: 0,
  /** Son yakalama hatası (popup'ta gösterilir) */
  lastError: ''
}

const DOWNLOAD_EXTS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'img',
  'exe', 'msi', 'msix', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appx',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma',
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts',
  'm3u8', 'mpd', 'torrent'
])

const EXTRACTOR_HOSTS =
  /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com|vimeo\.com|reddit\.com|dailymotion\.com|twitch\.tv|soundcloud\.com|pinterest\.(?:com|co\.[a-z]{2}|[a-z]{2})|pin\.it|vk\.com|vkvideo\.ru|bilibili\.com|b23\.tv|kick\.com)$/i

const MEDIA_TYPES =
  /^(video|audio)\/|mpegurl|dash\+xml|quicktime|matroska|ogg|mp4|webm/i

const FILE_TYPES =
  /^(application\/(zip|x-7z-compressed|vnd\.rar|x-rar-compressed|pdf|vnd\.microsoft|java-archive|x-msdownload|x-msi|x-apple-diskimage|octet-stream))|application\/x-bittorrent/i

// ---------------------------------------------------------------------------
// Ayarlar
// ---------------------------------------------------------------------------

async function cfgGet() {
  const saved = await api.storage.local.get(DEFAULTS)
  return Object.assign({}, DEFAULTS, saved)
}

async function cfgSet(patch) {
  await api.storage.local.set(patch)
}

// ---------------------------------------------------------------------------
// Köprü istemcisi
// ---------------------------------------------------------------------------

let cachedPort = 0
let lastFind = null
let lastFindAt = 0

async function findApp(force = false) {
  // Popup her 3 sn'de durum sorar; uygulama kapalıyken 10 portu taramayalım.
  if (!force && Date.now() - lastFindAt < 4000) return lastFind
  const cfg = await cfgGet()
  // Kayıtlı port her zaman önce denenir: kullanıcının farklı bir portta
  // çalışan IDMS'i (ya da eşleşmiş kurulumu) varsa 9789'a düşmesin.
  const order = [cfg.port, ...APP_PORTS.filter((p) => p !== cfg.port)]
  for (const port of order) {
    if (!port) continue
    try {
      const res = await fetch(`http://127.0.0.1:${port}/info`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(900)
      })
      if (!res.ok) continue
      const info = await res.json()
      if (!info || info.app !== 'IDMS') continue
      cachedPort = port
      lastFind = { port, info }
      lastFindAt = Date.now()
      if (cfg.port !== port) await cfgSet({ port })
      // Panel ayarı uygulamada değişmiş olabilir; içerik betikleri
      // storage.onChanged ile rozeti hemen gizler/gösterir.
      const panel = info.floatingPanel !== false
      if (cfg.floatingPanel !== panel) await cfgSet({ floatingPanel: panel })
      return lastFind
    } catch {
      /* sıradaki port */
    }
  }
  lastFind = null
  lastFindAt = Date.now()
  return null
}

async function pair(code) {
  const clean = String(code || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(clean)) {
    throw new Error('6 haneli eşleştirme kodunu girin')
  }
  const found = await findApp(true)
  if (!found) throw new Error('IDMS çalışmıyor (127.0.0.1:9789-9798)')
  const res = await fetch(`http://127.0.0.1:${found.port}/pair`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: clean,
      client: 'IDMS Extension',
      version: api.runtime.getManifest().version
    })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Eşleştirme başarısız (${res.status})`)
  await cfgSet({
    port: found.port,
    token: String(data.token || ''),
    paired: true,
    count: 0
  })
  connectEvents()
  updateBadge()
  return data
}

async function unpair() {
  await cfgSet({ paired: false, token: '', count: 0 })
  closeEvents()
  await api.storage.local.remove('detected')
  detectedCache = null
  updateBadge()
  broadcastToPopup({ type: 'unpaired' })
}

async function rpc(t, extra = {}) {
  const cfg = await cfgGet()
  if (!cfg.enabled) throw new Error('Eklenti devre dışı')
  if (!cfg.paired || !cfg.token) throw new Error('Önce IDMS ile eşleştirin')

  const send = (port) =>
    fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-IDMS-Token': cfg.token
      },
      body: JSON.stringify(
        Object.assign(
          { t, client: 'IDMS Extension', version: api.runtime.getManifest().version },
          extra
        )
      )
    })

  let res
  try {
    res = await send(cfg.port || cachedPort || APP_PORTS[0])
  } catch {
    const found = await findApp(true)
    if (!found) throw new Error('IDMS çalışmıyor')
    res = await send(found.port)
  }

  if (res.status === 401) {
    await cfgSet({ paired: false, token: '' })
    closeEvents()
    updateBadge()
    throw new Error('Eşleştirme geçersiz; kodla yeniden eşleştirin')
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `IDMS hatası (${res.status})`)
  }
  return res.json()
}

function isExtractorUrl(url) {
  try {
    return EXTRACTOR_HOSTS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

function fileNameOf(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
    return name || 'indirme'
  } catch {
    return 'indirme'
  }
}

function extensionOf(url) {
  try {
    const name = new URL(url).pathname.split('/').pop() || ''
    const m = /\.([a-z0-9]{1,8})$/i.exec(name)
    return m ? m[1].toLowerCase() : ''
  } catch {
    return ''
  }
}

/**
 * Sayfanın oturum çerezleri (Reddit/Instagram gibi giriş isteyen siteler için).
 * `cookies` izni gerekir; izin yoksa boş döner.
 */
async function cookiesFor(url) {
  try {
    if (!/^https?:/i.test(url || '')) return []
    const list = await api.cookies.getAll({ url })
    return (Array.isArray(list) ? list : []).slice(0, 80).map((c) => ({
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: String(c.domain || ''),
      path: String(c.path || '/'),
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined
    }))
  } catch {
    return []
  }
}

/** Bağlantı/medya/sayfa için doğru indirme yolunu seçer. */
async function sendTarget({ url, pageUrl, media, name }) {
  if (!url) throw new Error('Adres yok')
  if (media || isExtractorUrl(url) || /^blob:|^data:/i.test(url)) {
    const target = /^https?:/i.test(url) ? url : pageUrl
    if (!/^https?:/i.test(target || '')) throw new Error('Bu medya adresi indirilemiyor')
    const cookies = await cookiesFor(pageUrl || target)
    return rpc('download-media', {
      url: target,
      pageUrl: pageUrl || target,
      quality: 'best',
      cookies
    })
  }
  return rpc('download', {
    url,
    pageUrl: pageUrl || '',
    referrer: pageUrl || '',
    name: name || ''
  })
}

async function bumpCount(n) {
  const cfg = await cfgGet()
  await cfgSet({ count: Math.max(0, (cfg.count || 0) + n) })
  updateBadge()
}

// ---------------------------------------------------------------------------
// Canlı olaylar (WebSocket) + yüzen panel
// ---------------------------------------------------------------------------

let eventsWs = null
let eventsRetry = null

function connectEvents() {
  void (async () => {
    const cfg = await cfgGet()
    if (!cfg.paired || !cfg.token) {
      closeEvents()
      return
    }
    if (eventsWs && (eventsWs.readyState === WebSocket.CONNECTING || eventsWs.readyState === WebSocket.OPEN)) {
      return
    }
    clearTimeout(eventsRetry)
    const sock = new WebSocket(
      `ws://127.0.0.1:${cfg.port}/?token=${encodeURIComponent(cfg.token)}` +
        `&client=${encodeURIComponent('IDMS Extension')}` +
        `&version=${encodeURIComponent(api.runtime.getManifest().version)}`
    )
    eventsWs = sock
    const handshake = setTimeout(() => {
      try {
        sock.close()
      } catch {
        /* yoksay */
      }
    }, 4000)

    sock.onopen = () => {
      clearTimeout(handshake)
    }
    sock.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.t === 'status') {
        cfgSet({ count: Number(msg.active) || 0 })
        updateBadge()
        broadcastToPopup({ type: 'status', status: msg })
      } else if (msg.t === 'toast') {
        broadcastToPopup({ type: 'toast', toast: msg })
      } else if (msg.t === 'config') {
        // Uygulama panel ayarını değiştirdi: içerik betiklerine storage üzerinden
        // ulaşır (storage.onChanged).
        cfgSet({
          floatingPanel: msg.floatingPanel !== false,
          enabled: msg.enabled !== false
        })
      }
    }
    sock.onclose = (ev) => {
      clearTimeout(handshake)
      if (eventsWs === sock) eventsWs = null
      if (ev && ev.code === 4001) {
        // Uygulama eşleştirmeyi sıfırladı (token yenilendi)
        void (async () => {
          await cfgSet({ paired: false, token: '', count: 0 })
          updateBadge()
          broadcastToPopup({ type: 'unpaired' })
        })()
        return
      }
      scheduleReconnect()
    }
    sock.onerror = () => {
      try {
        sock.close()
      } catch {
        /* yoksay */
      }
    }
  })()
}

function scheduleReconnect() {
  clearTimeout(eventsRetry)
  eventsRetry = setTimeout(() => void connectEvents(), 6000)
}

function closeEvents() {
  clearTimeout(eventsRetry)
  eventsRetry = null
  const sock = eventsWs
  eventsWs = null
  if (sock) {
    try {
      sock.close()
    } catch {
      /* yoksay */
    }
  }
}

/** Adresin alan adı kökü (v.redd.it → redd.it) */
function baseDomainOf(url) {
  try {
    return new URL(url).hostname.split('.').slice(-2).join('.')
  } catch {
    return ''
  }
}

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * Sekmenin ağ gözetlemesinde görülen, bu videoya ait HLS/DASH adresi.
 * Sayfa kayıtlarında manifest görünmediğinde (gölge DOM, işçi, önbellek)
 * içerik betiğinin gönderdiği medya bu adresle tamamlanır.
 */
async function streamForTab(tabId, media, tabUrl) {
  const items = (await loadDetected())[tabId] || []
  const streams = items.filter((i) => i && i.kind === 'stream' && /^https?:/i.test(i.url || ''))
  if (!streams.length) return ''
  const hostKeys = new Set()
  const addHost = (u) => {
    const base = baseDomainOf(u)
    if (base) hostKeys.add(base)
  }
  addHost(media.pageUrl)
  addHost(media.url)
  addHost(tabUrl)
  for (const s of media.sources || []) addHost(s.url)
  const pageOrigin = originOf(media.pageUrl) || originOf(tabUrl)
  // Liste yeniden eskiye sıralıdır: en son istenen manifest önce denenir.
  for (const s of streams) {
    if (pageOrigin && originOf(s.pageUrl) === pageOrigin) return s.url
    if (hostKeys.has(baseDomainOf(s.url))) return s.url
  }
  return ''
}

/**
 * İçerik betiğinden gelen medya bilgisini temizler ve oynatıcının ağdan
 * aldığı HLS/DASH manifestini (varsa) ekler. Reddit gibi sitelerde oynatıcı
 * tek bir <source> gösterir; kaliteler manifestte listelenir ve içerik betiği
 * manifesti sayfa kayıtlarında bulamayabilir.
 */
async function floatMediaOf(raw, sender) {
  if (!raw || typeof raw.url !== 'string') return null
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const media = {
    url: text(raw.url, 2048),
    pageUrl: text(raw.pageUrl, 2048),
    title: text(raw.title, 300),
    pageTitle: text(raw.pageTitle, 300),
    kind: raw.kind === 'audio' ? 'audio' : 'video',
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    direct: raw.direct === true,
    needsExtractor: raw.needsExtractor === true,
    sources: Array.isArray(raw.sources)
      ? raw.sources
          .slice(0, 8)
          .filter((s) => s && typeof s.url === 'string')
          .map((s) => ({
            url: text(s.url, 2048),
            mime: text(s.mime, 80) || undefined,
            label: text(s.label, 40) || undefined
          }))
      : undefined,
    manifest: text(raw.manifest, 2048) || undefined
  }
  // Giriş isteyen sitelerde (Reddit, Instagram…) kalite listesi ve indirme
  // için oturum çerezleri gerekir; içerik betiği bunları okuyamaz.
  const cookieUrl = media.pageUrl || media.url
  if (/^https?:/i.test(cookieUrl)) {
    const cookies = await cookiesFor(cookieUrl)
    if (cookies.length) media.cookies = cookies
  }
  if (!media.manifest && sender?.tab?.id != null) {
    const manifest = await streamForTab(sender.tab.id, media, sender.tab.url)
    if (manifest) media.manifest = manifest
  }
  return media
}

/** /rpc yanıtındaki eşleşen yanıtı seçer (HTTP taşımasında replies dizisi gelir). */
function replyOf(data, t) {
  const list = data && Array.isArray(data.replies) ? data.replies : []
  return list.find((r) => r && r.t === t) || null
}

/**
 * Sayfa içi panelin uygulamaya sorduğu istek: kalite listesi, indirme ya da
 * eylem. Uygulama yanıtı olduğu gibi içerik betiğine döner.
 */
async function floatRequest(msg, sender) {
  const media = await floatMediaOf(msg.media, sender)
  if (!media) return { ok: false, error: 'Medya bilgisi yok' }
  const key = typeof msg.key === 'string' ? msg.key.slice(0, 2000) : ''
  const data = await rpc(msg.type, {
    key,
    media,
    kind: msg.kind === 'audio' ? 'audio' : 'video',
    formatId: typeof msg.formatId === 'string' ? msg.formatId.slice(0, 80) : undefined,
    action: msg.action === 'formats' ? 'formats' : undefined
  })
  const reply = replyOf(data, msg.type)
  if (!reply) {
    // Eylem istekleri (Formatlar… / IDMS'i aç) yalnızca ack ile yanıtlanır.
    if (msg.type === 'float-action') return { ok: !!(data && data.ok) }
    return { ok: false, error: data?.message || 'Uygulamadan yanıt gelmedi' }
  }
  return reply
}

// ---------------------------------------------------------------------------
// Algılananlar (webRequest)
// ---------------------------------------------------------------------------

let detectedCache = null
let detectedTimer = null

async function loadDetected() {
  if (detectedCache) return detectedCache
  const saved = await api.storage.local.get('detected')
  detectedCache = saved.detected && typeof saved.detected === 'object' ? saved.detected : {}
  return detectedCache
}

function saveDetectedSoon() {
  clearTimeout(detectedTimer)
  detectedTimer = setTimeout(() => {
    if (detectedCache) api.storage.local.set({ detected: detectedCache })
  }, 400)
}

function broadcastToPopup(message) {
  try {
    const p = api.runtime.sendMessage(message)
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    /* popup kapalı */
  }
}

async function addDetected(tabId, item) {
  const all = await loadDetected()
  const list = Array.isArray(all[tabId]) ? all[tabId] : []
  if (list.some((x) => x.url === item.url)) return
  list.unshift(item)
  all[tabId] = list.slice(0, 40)
  const keys = Object.keys(all)
  if (keys.length > 30) {
    for (const key of keys.slice(0, keys.length - 30)) delete all[key]
  }
  saveDetectedSoon()
  broadcastToPopup({ type: 'detected', tabId, items: all[tabId] })
  updateBadge()
}

async function clearDetected(tabId) {
  const all = await loadDetected()
  if (tabId == null) {
    for (const key of Object.keys(all)) delete all[key]
  } else {
    delete all[tabId]
  }
  await api.storage.local.set({ detected: all })
  updateBadge()
  broadcastToPopup({ type: 'detected', tabId, items: [] })
}

function classifyResponse(contentType, disposition, url) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  const cd = String(disposition || '')
  if (/attachment/i.test(cd)) return 'file'
  if (/\.m3u8(\?|#|$)|\.mpd(\?|#|$)/i.test(url) || /mpegurl|dash\+xml/i.test(ct)) return 'stream'
  if (MEDIA_TYPES.test(ct)) return 'media'
  if (FILE_TYPES.test(ct)) return 'file'
  if (DOWNLOAD_EXTS.has(extensionOf(url))) {
    return /^(mp3|m4a|aac|flac|wav|ogg|opus|wma|mp4|mkv|avi|mov|webm|m3u8|mpd)$/.test(
      extensionOf(url)
    )
      ? 'media'
      : 'file'
  }
  return ''
}

async function onHeadersReceived(details) {
  try {
    const cfg = await cfgGet()
    if (!cfg.enabled || !cfg.autoDetect) return
    if (details.tabId < 0) return
    const headers = details.responseHeaders || []
    const value = (name) => {
      const h = headers.find((x) => String(x.name || '').toLowerCase() === name)
      return String(h?.value || '')
    }
    const contentType = value('content-type')
    const disposition = value('content-disposition')
    const url = details.url
    if (!/^https?:/i.test(url)) return
    const kind = classifyResponse(contentType, disposition, url)
    if (!kind) return
    const total = /\/(\d+)\s*$/.exec(value('content-range'))
    const size = Number(total?.[1] || value('content-length') || 0) || 0
    await addDetected(details.tabId, {
      url,
      name: fileNameOf(url),
      mime: contentType.split(';')[0].trim().toLowerCase(),
      size,
      kind,
      pageUrl: details.initiator || '',
      ts: Date.now()
    })
  } catch {
    /* algılama hatası indirmeyi etkilemesin */
  }
}

api.webRequest.onHeadersReceived.addListener(
  (details) => void onHeadersReceived(details),
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders']
)

// ---------------------------------------------------------------------------
// İndirme devralma (IDM davranışı)
// ---------------------------------------------------------------------------

const takingOver = new Set()
let lastNotifyAt = 0

/**
 * Yakalama başarısız olduğunda durumu görünür kılar: rozet, popup ve (çok sık
 * olmamak kaydıyla) sistem bildirimi. Tarayıcı indirmesi artık iptal
 * edilmediği için dosya kaybolmaz; kullanıcı yalnızca neden IDMS'e
 * düşmediğini görür.
 */
async function reportCaptureError(err) {
  const message = String(err?.message || err || 'IDMS bağlantıyı alamadı')
  try {
    await cfgSet({ lastError: message })
  } catch {
    /* yoksay */
  }
  setBadge('!', '#d1242f')
  broadcastToPopup({ type: 'error', error: message })
  if (Date.now() - lastNotifyAt < 60000) return
  lastNotifyAt = Date.now()
  try {
    const ret = api.notifications.create({
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon128.png'),
      title: 'IDMS',
      message
    })
    if (ret && typeof ret.catch === 'function') ret.catch(() => {})
  } catch {
    /* bildirim izni yok */
  }
}

async function clearLastError() {
  try {
    const cfg = await cfgGet()
    if (cfg.lastError) await cfgSet({ lastError: '' })
  } catch {
    /* yoksay */
  }
}

async function onDownloadCreated(item) {
  try {
    const cfg = await cfgGet()
    if (!cfg.enabled || !cfg.takeOver || !cfg.paired) return
    if (item.byExtensionId) return
    if (takingOver.has(item.id)) return
    const url = item.finalUrl || item.url
    if (!/^https?:/i.test(url)) return

    takingOver.add(item.id)
    const name = item.filename ? item.filename.split(/[\\/]/).pop() : fileNameOf(url)
    try {
      // Önce IDMS'e ilet, sonra tarayıcı indirmesini iptal et. Ters sırada
      // (önce iptal) uygulama kapalıyken ya da eşleştirme geçersizken dosya
      // tamamen kayboluyordu: tarayıcı indirmesi de IDMS indirmesi de yok.
      await sendTarget({
        url,
        pageUrl: item.referrer || '',
        media: isExtractorUrl(url),
        name
      })
    } catch (err) {
      // IDMS almadı: tarayıcı indirmesi olduğu gibi devam etsin.
      void reportCaptureError(err)
      return
    }

    try {
      await api.downloads.cancel(item.id)
    } catch {
      /* iptal edilemedi */
    }
    try {
      await api.downloads.erase({ id: item.id })
    } catch {
      /* yoksay */
    }

    void clearLastError()
    bumpCount(1)
  } catch (err) {
    broadcastToPopup({ type: 'error', error: String(err?.message || err) })
    setBadge('!', '#d1242f')
  } finally {
    setTimeout(() => takingOver.delete(item.id), 5000)
  }
}

api.downloads.onCreated.addListener((item) => void onDownloadCreated(item))

// ---------------------------------------------------------------------------
// Sağ tık menüsü
// ---------------------------------------------------------------------------

async function setupMenus() {
  try {
    const ret = api.contextMenus.removeAll()
    if (ret && typeof ret.then === 'function') await ret
  } catch {
    /* menüler zaten yok */
  }
  api.contextMenus.create({ id: 'idms-link', title: 'IDMS ile indir', contexts: ['link'] })
  api.contextMenus.create({ id: 'idms-media', title: 'IDMS ile indir', contexts: ['video', 'audio'] })
  api.contextMenus.create({ id: 'idms-image', title: 'IDMS ile indir', contexts: ['image'] })
  api.contextMenus.create({
    id: 'idms-page',
    title: 'Sayfayı IDMS ile indir',
    contexts: ['page']
  })
}

api.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    const pageUrl = tab?.url || ''
    let target = ''
    let media = false
    if (info.menuItemId === 'idms-link') {
      target = info.linkUrl || ''
      media = isExtractorUrl(target)
    } else if (info.menuItemId === 'idms-media') {
      target = info.srcUrl || info.linkUrl || ''
      media = true
    } else if (info.menuItemId === 'idms-image') {
      target = info.srcUrl || info.linkUrl || ''
    } else if (info.menuItemId === 'idms-page') {
      target = pageUrl
    }
    if (!target) return
    try {
      await sendTarget({ url: target, pageUrl, media })
      bumpCount(1)
    } catch (err) {
      setBadge('!', '#d1242f')
      broadcastToPopup({ type: 'error', error: String(err?.message || err) })
    }
  })()
})

// ---------------------------------------------------------------------------
// Sekmeler ve rozet
// ---------------------------------------------------------------------------

function setBadge(text, color) {
  try {
    api.action.setBadgeText({ text })
    if (color) api.action.setBadgeBackgroundColor({ color })
  } catch {
    /* yoksay */
  }
}

async function updateBadge() {
  try {
    const cfg = await cfgGet()
    if (!cfg.enabled) return setBadge('')
    if (!cfg.paired) return setBadge('!', '#d1242f')
    const tabs = await api.tabs.query({ active: true, currentWindow: true })
    const list = (await loadDetected())[tabs[0]?.id] || []
    if (list.length) {
      setBadge(String(list.length), '#1a7bf0')
    } else if (cfg.count > 0) {
      setBadge(String(cfg.count), '#14743f')
    } else {
      setBadge('')
    }
  } catch {
    /* yoksay */
  }
}

api.tabs.onRemoved.addListener((tabId) => {
  if (detectedCache) delete detectedCache[tabId]
  saveDetectedSoon()
})

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    if (detectedCache) delete detectedCache[tabId]
    saveDetectedSoon()
    updateBadge()
  }
})

api.tabs.onActivated.addListener(() => void updateBadge())

// ---------------------------------------------------------------------------
// Popup / içerik betiği mesajları
// ---------------------------------------------------------------------------

async function activeTabId() {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true })
    return tabs[0]?.id ?? null
  } catch {
    return null
  }
}

async function stateForPopup() {
  const cfg = await cfgGet()
  const tabId = await activeTabId()
  const detected = (await loadDetected())[tabId] || []
  const found = await findApp()
  return {
    paired: cfg.paired,
    enabled: cfg.enabled,
    takeOver: cfg.takeOver,
    autoDetect: cfg.autoDetect,
    port: found?.port || cfg.port,
    online: !!found,
    integration: found ? found.info?.integration !== false : null,
    count: cfg.count,
    lastError: cfg.lastError,
    tabId,
    detected,
    origin: api.runtime.getURL('')
  }
}

async function onMessage(msg, sender) {
  switch (msg && msg.type) {
    case 'state':
      return { ok: true, state: await stateForPopup() }

    case 'pair': {
      await pair(msg.code)
      return { ok: true, state: await stateForPopup() }
    }

    case 'unpair':
      await unpair()
      return { ok: true }

    case 'config': {
      const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {}
      const allowed = {}
      for (const key of ['enabled', 'takeOver', 'autoDetect']) {
        if (typeof patch[key] === 'boolean') allowed[key] = patch[key]
      }
      await cfgSet(allowed)
      updateBadge()
      return { ok: true, state: await stateForPopup() }
    }

    case 'open-app':
      await rpc('open-app')
      return { ok: true }

    case 'download':
      await sendTarget({
        url: msg.url,
        pageUrl: msg.pageUrl || '',
        media: !!msg.media,
        name: msg.name || ''
      })
      bumpCount(1)
      return { ok: true }

    case 'download-detected': {
      const item = msg.item || {}
      if (!item.url) return { ok: false, error: 'Adres yok' }
      await sendTarget({
        url: item.url,
        pageUrl: item.pageUrl || sender?.tab?.url || '',
        media: item.kind === 'media' || item.kind === 'stream',
        name: item.name || ''
      })
      bumpCount(1)
      return { ok: true }
    }

    case 'detected':
      return {
        ok: true,
        items: (await loadDetected())[msg.tabId] || []
      }

    case 'clear-detected':
      await clearDetected(msg.tabId)
      return { ok: true }

    // --- İçerik betiği: sayfa içi yüzen panel ---
    case 'float-formats':
    case 'float-download':
    case 'float-action': {
      // Yalnızca bir sekmede çalışan içerik betiğinden kabul edilir.
      if (!sender?.tab) return { ok: false, error: 'Yalnızca sayfa içinden kullanılabilir' }
      return await floatRequest(msg, sender)
    }

    case 'link-click': {
      try {
        await sendTarget({
          url: msg.url,
          pageUrl: msg.pageUrl || sender?.tab?.url || '',
          media: !!msg.media,
          name: msg.name || ''
        })
      } catch (err) {
        // İçerik betiği bu hatayı görüp tıklamayı tarayıcıya geri bırakır.
        const message = String(err?.message || err)
        await cfgSet({ lastError: message }).catch(() => {})
        broadcastToPopup({ type: 'error', error: message })
        return { ok: false, error: message }
      }
      await cfgSet({ lastError: '' }).catch(() => {})
      bumpCount(1)
      return { ok: true, message: 'IDMS kuyruğuna eklendi' }
    }

    default:
      return { ok: false, error: 'Bilinmeyen mesaj' }
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.type === 'status' || msg.type === 'toast' || msg.type === 'detected' || msg.type === 'error')) {
    return false // popup yayınları; yanıt beklenmiyor
  }
  onMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
  return true
})

// ---------------------------------------------------------------------------
// Yaşam döngüsü
// ---------------------------------------------------------------------------

api.runtime.onInstalled.addListener(() => {
  setupMenus()
  void findApp()
  updateBadge()
})

api.runtime.onStartup.addListener(() => {
  setupMenus()
  void findApp()
  connectEvents()
  updateBadge()
})

// Service worker her uyandığında bağlantıyı tazele
void findApp()
connectEvents()
updateBadge()
