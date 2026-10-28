import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  protocol
} from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync, writeFileSync, promises as fsp } from 'fs'
import type {
  AddDownloadRequest,
  AppToast,
  DeepPartial,
  DownloadItem,
  ExtensionEvent,
  FloatFormat,
  FloatMediaInfo,
  IpcApi,
  MediaDownloadRequest,
  Settings
} from '@shared/types'
import { Store } from './store'
import { DownloadManager, startScheduler } from './engine/manager'
import { Notifier } from './notify'
import { ExtensionServer } from './extServer'
import { TorrentManager, registerMagnetProtocol } from './torrent'
import { ToolLocator, YtdlpRunner } from './ytdlp'
import { probeUrl } from './engine/probe'
import { FloatPanel } from './floatPanel'
import {
  classifyProbeError,
  formatsFromProbe,
  formatsFromSources,
  isGenericPage,
  isStreamAddress,
  type FloatProbeResult
} from './floatFormats'
import { fillFormatSizes } from './floatSizes'
import { setLanguage, t, formatBytes, formatSpeed } from './lang'

// ---------------------------------------------------------------------------
// Tek örnek kilidi: ikinci kopya açılırsa mevcut pencereyi öne getir
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let store: Store
let manager: DownloadManager
let notifier: Notifier
let extServer: ExtensionServer
let torrentMgr: TorrentManager
let locator: ToolLocator
let ytdlp: YtdlpRunner
let floatPanel: FloatPanel
let stopScheduler: (() => void) | null = null
let clipboardTimer: ReturnType<typeof setInterval> | null = null

const toasts: AppToast[] = []

// ---------------------------------------------------------------------------
// Pencere
// ---------------------------------------------------------------------------
function createWindow(): void {
  const settings = store.getSettings()
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f4f6f9',
    title: 'IDMS2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => {
    if (settings.general.startMinimized) {
      win?.showInactive()
    } else {
      win?.show()
    }

    // Test modu: `--screenshot [yol]` ile pencereyi yakalayıp çıkar
    if (process.argv.includes('--screenshot')) {
      const idx = process.argv.indexOf('--screenshot')
      const outPath =
        process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')
          ? process.argv[idx + 1]
          : join(app.getPath('temp'), 'idms2-screenshot.png')
      setTimeout(async () => {
        try {
          if (!win) return
          const img = await win.webContents.capturePage()
          writeFileSync(outPath, img.toPNG())
          console.log('[screenshot]', outPath)
        } catch (e) {
          console.error('[screenshot] failed', e)
        }
        app.exit(0)
      }, 3500)
    }
  })

  // Konsol hatalarını görünür kıl (test logları için)
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    }
  })

  // Dış bağlantılar tarayıcıda açılsın
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    win = null
  })
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------------------
// Bildirim boru hattı
// ---------------------------------------------------------------------------
function wireNotifier(): void {
  notifier.on('toast', (toast: AppToast) => {
    toasts.unshift(toast)
    if (toasts.length > 100) toasts.length = 100
    sendToRenderer('toast', toast)
    extServer.broadcastToast(toast.title, toast.message, toast.stage as any)
  })

  notifier.on('start-action', ({ id, action }: { id: string; action: string }) => {
    if (action === 'approve') manager.confirm(id, undefined, true)
    else if (action === 'cancel') {
      try {
        manager.cancel(id)
      } catch {
        /* yoksay */
      }
    }
  })

  notifier.on('clipboard-download', ({ url }: { url: string }) => {
    void manager.add({ url, silent: false })
  })

  notifier.on('retry', ({ id }: { id: string }) => manager.start(id))
}

// ---------------------------------------------------------------------------
// İndirme yaşam döngüsü → bildirim + eklenti durumu
// ---------------------------------------------------------------------------
function wireManager(): void {
  manager.on('downloads', (items: DownloadItem[]) => {
    sendToRenderer('downloads', items)
    extServer.broadcastStatus()
  })

  manager.on('progress', (item: DownloadItem) => {
    sendToRenderer('progress', item)
    if (item.state === 'downloading') notifier.notifyProgress(item)
  })

  manager.on('completed', (item: DownloadItem) => {
    notifier.notifyComplete(item)
    sendToRenderer('item', item)
  })

  manager.on('download-error', (item: DownloadItem) => {
    notifier.notifyError(item)
    sendToRenderer('item', item)
  })

  // "İndirmeden önce" bildirimi: onay modu açıksa istek anında toast göster
  manager.on('confirm-required', (item: DownloadItem) => {
    notifier.notifyStart(item, true)
  })
}

// ---------------------------------------------------------------------------
// Pano izleme
// ---------------------------------------------------------------------------
function startClipboardMonitor(): void {
  stopClipboardMonitor()
  let last = ''
  clipboardTimer = setInterval(() => {
    if (!store.getSettings().general.monitorClipboard) return
    try {
      const text = clipboard.readText('clipboard').trim()
      if (!text || text === last) return
      last = text
      if (!/^https?:\/\/\S+$/i.test(text)) return
      // Aynı URL zaten listede mi?
      const exists = manager.list().some((d) => d.url === text)
      if (exists) return
      notifier.notifyClipboard(text)
    } catch {
      /* yoksay */
    }
  }, 2500)
}

function stopClipboardMonitor(): void {
  if (clipboardTimer) {
    clearInterval(clipboardTimer)
    clipboardTimer = null
  }
}

// ---------------------------------------------------------------------------
// Eklenti → medya indirme akışı (yt-dlp)
// ---------------------------------------------------------------------------
function wireExtensionMedia(): void {
  extServer.on(
    'media-download-requested',
    (payload: {
      url: string
      pageUrl?: string
      quality?: 'best' | 'audio'
      cookies?: any[]
    }) => {
      void startMediaDownload({
        url: payload.url,
        pageUrl: payload.pageUrl,
        quality: payload.quality,
        cookies: payload.cookies
      })
    }
  )

  extServer.on('media-detected', ({ count, title }: { count: number; title: string }) => {
    const evt: ExtensionEvent = { type: 'media-detected', count, title }
    sendToRenderer('extension-event', evt)
  })

  // Yüzen IDMS paneli: eklenti oynayan medyayı ve ekran dikdörtgenini bildirir
  extServer.on('float-media', (payload: any) => floatPanel.handle(payload))
  extServer.on('open-app-requested', () => revealMainWindow())

  extServer.on('client-added', (client: string) => {
    sendToRenderer('extension-event', { type: 'connected', client })
  })
  extServer.on('client-left', (client: string) => {
    sendToRenderer('extension-event', { type: 'disconnected', client })
  })
  extServer.on('status', (status) => sendToRenderer('server-status', status))
}

/** Sosyal medya indirmesini oluşturur ve yt-dlp'i koşar. */
async function startMediaDownload(req: MediaDownloadRequest): Promise<{ id: string } | null> {
  const settings = store.getSettings()
  const quality = req.quality || settings.social.preferredQuality
  // Ses-only istek "audio", diğerleri "video" klasörüne gider
  const mediaCategory = quality === 'audio' ? 'audio' : 'video'
  const saveDir = req.saveDir || join(settings.general.downloadDir, mediaCategory)

  const bin = locator.findYtdlp()
  if (!bin) {
    // yt-dlp yok: kullanıcıya bildir, ayarlara yönlendir
    const toast: AppToast = {
      id: `t_ytdlp_${Date.now().toString(36)}`,
      stage: 'error',
      title: t('common.error'),
      message: t('err.ytdlpMissing'),
      createdAt: Date.now()
    }
    toasts.unshift(toast)
    sendToRenderer('toast', toast)
    return null
  }

  // Kaydı "çözümleniyor" olarak ekle, format bilgisi sonra güncellenir
  const item = await manager.add({
    url: req.url,
    pageUrl: req.pageUrl,
    name: req.name || undefined,
    savePath: undefined,
    silent: req.silent ?? !settings.general.confirmBeforeDownload,
    kind: 'media'
  })
  manager.patchItem(item.id, {
    category: mediaCategory,
    media: {
      site: hostOf(req.url),
      wantedQuality: quality,
      formatId: req.formatId
    }
  })

  const created = manager.get(item.id)
  if (created) notifier.notifyStart(created, false)
  sendToRenderer('extension-event', { type: 'download-requested', url: req.url })

  const controller = new AbortController()
  mediaControllers.set(item.id, controller)

  manager.externalStarted(item.id)

  void (async () => {
    try {
      const result = await ytdlp.download(
        {
          url: req.url,
          saveDir,
          formatId: req.formatId,
          quality,
          pageUrl: req.pageUrl,
          cookies: req.cookies,
          useCookies: settings.social.passCookies,
          impersonate: settings.social.impersonate
        },
        {
          onStart: () => manager.externalStarted(item.id),
          onProgress: (p) => {
            manager.externalProgress(item.id, {
              percent: p.percent,
              speed: p.speed,
              etaSeconds: p.etaSeconds,
              downloadedBytes: Math.round(p.percent * 1000),
              totalBytes: 1000,
              statusLine: p.statusLine
            })
          }
        },
        controller.signal
      )
      manager.externalComplete(item.id, result.filePath)
    } catch (e: any) {
      const msg = e?.message || t('err.generic')
      if (msg.includes('iptal')) manager.externalState(item.id, 'canceled')
      else manager.externalError(item.id, msg)
    } finally {
      mediaControllers.delete(item.id)
    }
  })()

  return { id: item.id }
}

const mediaControllers = new Map<string, AbortController>()

function hostOf(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Yüzen IDMS paneli (IDM'nin yüzen paneli gibi)
// ---------------------------------------------------------------------------
function isDirectMedia(m: FloatMediaInfo): boolean {
  if (m.direct !== true) return false
  if (!/^https?:\/\//i.test(m.url || '')) return false
  return !/\.m3u8(\?|#|$)|\.mpd(\?|#|$)|\/manifest/i.test(m.url)
}

/**
 * Panelden indirilen dosyanın adı: video başlığı + kaynağın uzantısı.
 * Başlık tek başına kullanılırsa dosya uzantısız (ve "diğer" kategorisinde) kalırdı.
 */
function floatFileName(m: FloatMediaInfo, url?: string): string | undefined {
  const title = (m.title || '').replace(/\s+/g, ' ').trim()
  if (!title) return undefined
  const match = /\/([^/?#]+)\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(url || m.url || '')
  const ext = match ? match[2].toLowerCase() : ''
  if (!ext) return title
  if (new RegExp(`\\.${ext}$`, 'i').test(title)) return title
  return `${title}.${ext}`
}

/** Panelde bir kalite/ses satırı seçilince indirmeyi başlatır. */
async function floatDownload(
  m: FloatMediaInfo,
  kind: 'video' | 'audio',
  format?: FloatFormat
): Promise<{ ok: boolean; message?: string }> {
  try {
    // Sayfa adresi: blob:/sosyal medyada yt-dlp sayfayı çözer
    const target =
      m.needsExtractor || !/^https?:\/\//i.test(m.url) ? m.pageUrl || m.url : m.url

    // 1) Oynatıcının sunduğu doğrudan dosya (kalite) → HTTP motoru, yt-dlp yok
    if (format?.url && !isStreamAddress(format.url)) {
      await manager.add({
        url: format.url,
        pageUrl: m.pageUrl,
        name: floatFileName(m, format.url),
        // Kullanıcı kaliteyi panelden seçti → onay penceresi beklenmez
        silent: true
      })
      return { ok: true, message: t('float.added') }
    }

    // 2) HLS/DASH yayını ya da yt-dlp biçimi → yt-dlp
    if (format || !isDirectMedia(m)) {
      const ytdlpTarget = format?.url || target
      if (!/^https?:\/\//i.test(ytdlpTarget)) {
        return { ok: false, message: t('float.unsupported') }
      }
      const isYtdlpFormat = !!format && !format.formatId.includes(':') && format.formatId !== 'direct'
      const res = await startMediaDownload({
        url: ytdlpTarget,
        pageUrl: m.pageUrl,
        quality: kind === 'audio' ? 'audio' : 'best',
        formatId: isYtdlpFormat ? format.formatId : undefined,
        name: kind === 'audio' ? undefined : m.title || undefined,
        silent: true
      })
      if (!res) return { ok: false, message: t('err.ytdlpMissing') }
      return { ok: true, message: t('float.queued') }
    }

    // 3) Seçim yok + doğrudan dosya: HTTP motoruyla en iyi (tek) kopya
    await manager.add({
      url: m.url,
      pageUrl: m.pageUrl,
      name: floatFileName(m),
      silent: true
    })
    return { ok: true, message: t('float.added') }
  } catch (e: any) {
    return { ok: false, message: e?.message || t('common.error') }
  }
}

/**
 * Panelin kalite listesi: oynatıcının <source> seçenekleri varsa onlar,
 * yoksa yt-dlp biçim listesi (video kaliteleri + ses dosyaları).
 */
async function floatProbeFormats(m: FloatMediaInfo): Promise<FloatProbeResult> {
  const hasSources = Array.isArray(m.sources) && m.sources.length > 0
  const hasYtdlp = !!locator.findYtdlp()
  const audioExtract = hasYtdlp && !!locator.findFfmpeg()

  // Doğrudan dosya / çoklu <source>: hızlı yol, yt-dlp beklemesi yok
  if (hasSources || isDirectMedia(m)) {
    const formats = formatsFromSources(m, { audioExtract })
    if (!formats.length) return { ok: false, formats: [], note: t('float.noFormats') }
    // Boyutlar oynatıcıdan gelmez: HEAD ile Content-Length sorgulanır.
    return { ok: true, formats: await fillFormatSizes(formats, { pageUrl: m.pageUrl }) }
  }

  const target =
    m.needsExtractor || !/^https?:\/\//i.test(m.url) ? m.pageUrl || m.url : m.url
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, formats: [], note: t('float.unsupported') }
  }
  // Ana sayfa, keşfet veya profil gibi liste sayfalarını yt-dlp çözemez
  // ("Unsupported URL"); ham hata yerine kısa bir yönlendirme gösterilir.
  if (isGenericPage(target)) {
    return { ok: false, formats: [], note: t('float.pageNotSpecific') }
  }
  if (!hasYtdlp) return { ok: false, formats: [], note: t('float.needYtdlp') }

  try {
    const settings = store.getSettings()
    const probe = await withTimeout(
      ytdlp.probe({
        url: target,
        useCookies: settings.social.passCookies,
        impersonate: settings.social.impersonate
      }),
      25000,
      t('float.probeTimeout')
    )
    if (!probe.ok) {
      return { ok: false, formats: [], note: probeErrorNote(probe.error) }
    }
    const formats = formatsFromProbe(probe.formats)
    if (!formats.length) return { ok: false, formats: [], note: t('float.noFormats') }
    return { ok: true, formats }
  } catch (e: any) {
    return { ok: false, formats: [], note: probeErrorNote(String(e?.message || e)) }
  }
}

/** yt-dlp'nin ham hata metnini kısa, çevrilmiş bir nota çevirir. */
function probeErrorNote(raw?: string): string {
  if (raw) console.warn('[float] kalite listesi:', raw)
  switch (classifyProbeError(raw)) {
    case 'login':
      return t('float.needLogin')
    case 'unsupported':
      return t('float.pageNotSpecific')
    case 'unavailable':
      return t('float.unavailable')
    default:
      return t('float.probeFailed')
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** "Formatlar…" → ana pencerede medya (yt-dlp biçim) penceresi. */
function floatOpenFormats(m: FloatMediaInfo): void {
  const url = m.needsExtractor || !/^https?:\/\//i.test(m.url) ? m.pageUrl || m.url : m.url
  const open = (): void => sendToRenderer('open-media', { ...m, url })
  const fresh = !win
  revealMainWindow()
  setTimeout(open, fresh ? 1200 : 120)
}

function revealMainWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron
  }))

  ipcMain.handle('settings:get', () => store.getSettings())

  ipcMain.handle('settings:patch', (_e, patch: DeepPartial<Settings>) => {
    const before = store.getSettings()
    const next = store.patchSettings(patch as Partial<Settings>)
    setLanguage(next.general.language)
    locator?.updateSettings(next)

    // Eklenti sunucusu yaşam döngüsü
    if (patch.extension && extServer) {
      if (!next.extension.enabled) void extServer.stop()
      else void extServer.start()
    }
    // Yüzen panel kapatıldıysa pencereyi kaldır
    if (patch.extension && floatPanel) {
      if (!next.extension.enabled || next.extension.floatingPanel === false) floatPanel.destroy()
    }
    // Pano izleme
    if (patch.general && next.general.monitorClipboard && !clipboardTimer) {
      startClipboardMonitor()
    }
    void before
    sendToRenderer('settings', next)
    return next
  })

  ipcMain.handle('dialog:pickDirectory', async (_e, defaultPath?: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title: t('add.saveTo'),
      defaultPath: defaultPath || store.getSettings().general.downloadDir,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:pickTorrent', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: t('torrent.pick'),
      properties: ['openFile'],
      filters: [{ name: 'Torrent', extensions: ['torrent'] }]
    })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:showItemInFolder', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('ext:dir', () =>
    app.isPackaged
      ? join(process.resourcesPath, 'extension')
      : join(app.getAppPath(), 'extension')
  )
  ipcMain.handle('shell:openExternal', (_e, u: string) => shell.openExternal(u))

  ipcMain.handle('downloads:list', () => manager.list())

  ipcMain.handle('downloads:probe', async (_e, url: string, pageUrl?: string) =>
    probeUrl(url, { pageUrl })
  )

  ipcMain.handle('downloads:add', async (_e, req: AddDownloadRequest) => {
    const item = await manager.add(req)
    // Onay modu açıksa "öncesi" bildirimini yayınla
    const settings = store.getSettings()
    if (settings.general.confirmBeforeDownload && !req.silent) {
      const fresh = manager.get(item.id)
      if (fresh) notifier.notifyStart(fresh, true)
      sendToRenderer('confirm-required', fresh)
    }
    return { id: item.id, state: manager.get(item.id)?.state }
  })

  ipcMain.handle('downloads:start', (_e, id: string) => manager.start(id))
  ipcMain.handle('downloads:pause', (_e, id: string) => manager.pause(id))
  ipcMain.handle('downloads:queue', (_e, id: string) => manager.queue(id))
  ipcMain.handle('downloads:resume', (_e, id: string) => manager.resume(id))
  ipcMain.handle('downloads:cancel', (_e, id: string) => manager.cancel(id))
  ipcMain.handle('downloads:remove', (_e, id: string, deleteFile: boolean) =>
    manager.remove(id, deleteFile)
  )
  ipcMain.handle('downloads:confirm', (_e, id: string, savePath?: string, start?: boolean) => {
    const item = manager.confirm(id, savePath, start ?? true)
    return manager.get(id) || item
  })
  ipcMain.handle('downloads:schedule', (_e, id: string, at: number | null) =>
    manager.schedule(id, at)
  )
  ipcMain.handle('downloads:clearCompleted', () => manager.clearCompleted())
  ipcMain.handle('downloads:pickSavePath', async (_e, id: string) => {
    const item = manager.get(id)
    if (!item) return null
    const res = await dialog.showSaveDialog(win!, {
      title: t('add.saveTo'),
      defaultPath: item.savePath
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })

  // --- Sosyal medya ---
  ipcMain.handle('media:probe', async (_e, url: string, pageUrl?: string, cookies?: any[]) => {
    const settings = store.getSettings()
    if (!locator.findYtdlp()) {
      return {
        ok: false,
        pageUrl: url,
        title: '',
        extractor: '',
        formats: [],
        error: t('err.ytdlpMissing')
      }
    }
    return ytdlp.probe({
      url,
      cookies,
      useCookies: settings.social.passCookies,
      impersonate: settings.social.impersonate
    })
  })

  ipcMain.handle('media:download', (_e, req: MediaDownloadRequest) => startMediaDownload(req))
  ipcMain.handle('media:cancel', (_e, id: string) => {
    mediaControllers.get(id)?.abort()
  })

  /** yt-dlp'i resmi GitHub sürümünden indirir ve ayarlara kaydeder. */
  ipcMain.handle('social:fetchYtdlp', async () => {
    const dest = join(app.getPath('userData'), 'idms2', 'bin', 'yt-dlp.exe')
    await fsp.mkdir(dirname(dest), { recursive: true })
    const res = await fetch(
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
      { redirect: 'follow' }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fsp.writeFile(dest, buf)
    store.patchSettings({ social: { ytdlpPath: dest } })
    locator.updateSettings(store.getSettings())
    sendToRenderer('settings', store.getSettings())
    return dest
  })

  /** Belgeyi (binary dahil) userData/bin altına yazar; yol döndürür. */
  ipcMain.handle(
    'tools:saveFile',
    async (_e, fileName: string, base64: string) => {
      const safe = basename(fileName).replace(/[<>:"/\\|?*]/g, '_')
      const dest = join(app.getPath('userData'), 'idms2', 'bin', safe)
      await fsp.mkdir(dirname(dest), { recursive: true })
      await fsp.writeFile(dest, Buffer.from(base64, 'base64'))
      return dest
    }
  )

  // --- Torrent ---
  ipcMain.handle('torrent:add', async (_e, input: { magnetOrPath: string; saveDir?: string }) => {
    const settings = store.getSettings()
    const res = await torrentMgr.add(input.magnetOrPath, input.saveDir)
    // Torrent'i downloads listesine de yaz (tek liste görünümü)
    const item = await manager.add({
      url: input.magnetOrPath,
      name: torrentMgr.name(res.id) || 'torrent',
      savePath: join(input.saveDir || settings.torrent.saveDir, torrentMgr.name(res.id) || 'torrent'),
      silent: true,
      kind: 'torrent'
    })
    manager.patchItem(item.id, {
      category: 'other',
      torrent: {
        magnetOrPath: input.magnetOrPath,
        peers: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        ratio: 0,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0
      }
    })
    torrentLinks.set(res.id, item.id)
    manager.externalStarted(item.id)
    notifier.notifyStart({ ...item, state: 'downloading' }, false)
    return { id: item.id, torrentId: res.id }
  })

  // --- Eklenti sunucusu ---
  ipcMain.handle('ext:status', () => extServer.status)
  ipcMain.handle('ext:regenerateCode', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let s = ''
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]
    store.patchSettings({ extension: { pairingCode: s } })
    sendToRenderer('server-status', extServer.status)
    return s
  })
  ipcMain.handle('ext:code', () => store.getSettings().extension.pairingCode)
  ipcMain.handle('ext:revoke', () => {
    const status = extServer.revoke()
    sendToRenderer('server-status', status)
    return status
  })

  // --- Bildirimler ---
  ipcMain.handle('notify:test', (_e, stage: any) => notifier.sendTest(stage))
  ipcMain.handle('notify:toasts', () => toasts)
  ipcMain.handle('notify:clear', (_e, id?: string) => {
    if (id) {
      const idx = toasts.findIndex((x) => x.id === id)
      if (idx >= 0) toasts.splice(idx, 1)
      return toasts
    }
    toasts.length = 0
    return []
  })

  // --- Kuyruk özeti (durum çubuğu) ---
  ipcMain.handle('downloads:summary', () => manager.summary())

  // --- Pencere kontrolleri (özel başlık çubuğu) ---
  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:isMaximized', () => win?.isMaximized() ?? false)
  ipcMain.handle('window:close', () => win?.close())
}

const torrentLinks = new Map<string, string>() // torrentId → downloadId

// ---------------------------------------------------------------------------
// Torrent olaylarını indirme listesine yansıt
// ---------------------------------------------------------------------------
function wireTorrents(): void {
  torrentMgr.on('progress', (torrentId: string, snap: any) => {
    const dlId = torrentLinks.get(torrentId)
    if (!dlId) return
    manager.externalProgress(dlId, {
      percent: snap.progress,
      downloadedBytes: snap.downloadedBytes,
      totalBytes: snap.totalBytes,
      speed: snap.downloadSpeed,
      etaSeconds:
        snap.downloadSpeed > 0
          ? Math.round((snap.totalBytes - snap.downloadedBytes) / snap.downloadSpeed)
          : null
    })
    const item = manager.get(dlId)
    if (item?.torrent) {
      item.torrent.peers = snap.peers
      item.torrent.downloadSpeed = snap.downloadSpeed
      item.torrent.uploadSpeed = snap.uploadSpeed
      item.torrent.ratio = snap.ratio
      item.torrent.progress = snap.progress
      item.torrent.totalBytes = snap.totalBytes
      item.torrent.downloadedBytes = snap.downloadedBytes
    }
  })

  torrentMgr.on('done', (torrentId: string) => {
    const dlId = torrentLinks.get(torrentId)
    if (dlId) manager.externalComplete(dlId)
  })

  torrentMgr.on('torrent-error', (torrentId: string, message: string) => {
    const dlId = torrentLinks.get(torrentId)
    if (dlId) manager.externalError(dlId, message)
  })
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray(): void {
  try {
    const iconPath = join(app.getAppPath(), 'resources', 'icon.png')
    const img = existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty()
    tray = new Tray(img)
    tray.setToolTip('IDMS2 — ' + t('app.tagline'))
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('tray.open'), click: () => {
            if (win) {
              win.show()
              win.focus()
            } else createWindow()
          } },
        { type: 'separator' },
        { label: t('toolbar.completed'), click: () => shell.openPath(store.getSettings().general.downloadDir) },
        { type: 'separator' },
        { label: t('tray.quit', {}), click: () => app.quit() }
      ])
    )
    tray.on('click', () => {
      if (win) {
        win.show()
        win.focus()
      } else createWindow()
    })
  } catch (e) {
    console.error('[tray]', e)
  }
}

// ---------------------------------------------------------------------------
// Yaşam döngüsü
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  store = new Store()
  setLanguage(store.getSettings().general.language)
  registerMagnetProtocol()

  manager = new DownloadManager(store)
  notifier = new Notifier(store)
  extServer = new ExtensionServer(store, manager)
  torrentMgr = new TorrentManager(store)
  locator = new ToolLocator(store.getSettings())
  ytdlp = new YtdlpRunner(locator, join(app.getPath('userData'), 'idms2', 'tmp'))

  floatPanel = new FloatPanel({
    store,
    download: floatDownload,
    probeFormats: floatProbeFormats,
    openFormats: floatOpenFormats,
    showMainWindow: revealMainWindow
  })

  wireNotifier()
  wireManager()
  wireExtensionMedia()
  wireTorrents()
  registerIpc()

  stopScheduler = startScheduler(manager)
  torrentMgr.startTicking()

  createWindow()
  createTray()
  startClipboardMonitor()

  await extServer.start()

  // Magnet bağlantıları: `app -- "magnet:?xt=..."`
  const magnet = process.argv.find((a) => a.startsWith('magnet:?'))
  if (magnet) void addMagnet(magnet)
  app.on('second-instance', (_e, argv) => {
    const m = argv.find((a) => a.startsWith('magnet:?'))
    if (m) void addMagnet(m)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  // Protokol çağrısı (macOS'ta open-url, Windows'ta second-instance)
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (url.startsWith('magnet:?')) void addMagnet(url)
  })
})

async function addMagnet(magnet: string): Promise<void> {
  try {
    const res = await torrentMgr.add(magnet)
    const settings = store.getSettings()
    const item = await manager.add({
      url: magnet,
      name: torrentMgr.name(res.id) || 'torrent',
      savePath: join(settings.torrent.saveDir, torrentMgr.name(res.id) || 'torrent'),
      silent: true,
      kind: 'torrent'
    })
    manager.patchItem(item.id, {
      torrent: {
        magnetOrPath: magnet,
        peers: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        ratio: 0,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0
      }
    })
    torrentLinks.set(res.id, item.id)
    manager.externalStarted(item.id)
    if (win) win.show()
  } catch (e: any) {
    console.error('[magnet]', e)
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  // Kapatınca arka planda kalmasın (Windows davranışı)
  app.quit()
})

let shuttingDown = false
app.on('before-quit', async (e) => {
  if (shuttingDown) return
  shuttingDown = true
  e.preventDefault()
  try {
    stopClipboardMonitor()
    stopScheduler?.()
    await extServer.stop()
    floatPanel?.destroy()
    manager.persistNow()
    await torrentMgr.shutdown()
  } catch (err) {
    console.error('[quit]', err)
  } finally {
    app.exit(0)
  }
})
