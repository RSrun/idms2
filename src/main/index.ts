import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Tray,
  Menu,
  nativeImage
} from 'electron'
import { join, dirname, basename, extname } from 'path'
import { spawn } from 'child_process'
import {
  existsSync,
  writeFileSync,
  appendFileSync,
  promises as fsp,
  mkdirSync,
  copyFileSync,
  unlinkSync
} from 'fs'
import type {
  AddDownloadRequest,
  AppToast,
  DeepPartial,
  DownloadItem,
  DownloadState,
  DownloadWindowAction,
  DownloadWindowRequest,
  ExtensionEvent,
  FloatFormat,
  FloatMediaInfo,
  GeckoInstallResult,
  MediaDownloadRequest,
  Settings
} from '@shared/types'
import { Store } from './store'
import { DownloadManager, categoryForFilename, startScheduler, uniquePath } from './engine/manager'
import { Notifier } from './notify'
import { ExtensionServer } from './extServer'
import { TorrentManager, registerMagnetProtocol } from './torrent'
import { ToolLocator, YtdlpRunner } from './ytdlp'
import { probeUrl } from './engine/probe'
import { FloatService } from './floatService'
import { DownloadWindows, type DownloadWindowContext } from './downloadWindows'
import {
  installGeckoExtension,
  listGeckoProfiles,
  pathsEqual,
  uninstallGeckoExtension
} from './extGecko'

import {
  classifyProbeError,
  formatsFromProbe,
  formatsFromSources,
  isGenericPage,
  isStreamAddress,
  probeFirstTarget,
  type FloatProbeResult
} from './floatFormats'
import { fillFormatSizes } from './floatSizes'
import { setLanguage, t } from './lang'

// ---------------------------------------------------------------------------
// Kullanıcı verisi klasörü
// ---------------------------------------------------------------------------

/**
 * Chromium, kullanıcı verisi klasörüne kilit dosyası yazamazsa uygulama
 * sessizce kapanır (requestSingleInstanceLock false döner). Uygulama kısıtlı
 * bir ortamda (ör. düşük bütünlükte) çalıştırıldığında %APPDATA% yazılamaz;
 * bu durumda kurulum klasörünün yanındaki "userdata" klasörüne geçilir ve
 * mevcut ayarlar oraya bir kez kopyalanır. Böylece uygulama yine de açılır.
 */
function resolveUserDataDir(): void {
  const def = app.getPath('userData')
  const portable = join(dirname(app.getPath('exe')), 'userdata')

  const writable = (dir: string): boolean => {
    // accessSync yalnızca ACL'e bakar; düşük bütünlükteki süreçlerde
    // bütünlük etiketi yazmayı yine de engeller. Bu yüzden gerçek bir
    // yazma denemesi yapılır.
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(probe, 'ok', 'utf8')
      unlinkSync(probe)
      return true
    } catch {
      return false
    }
  }

  // Daha önce taşınmış bir profil varsa her açılışta onu kullan: böylece
  // kısıtlı ve normal başlatmalar aynı ayarları/indirmeleri görür.
  if (existsSync(join(portable, 'idms2', 'settings.json'))) {
    app.setPath('userData', portable)
    return
  }

  if (writable(def) || !writable(portable)) return

  try {
    mkdirSync(join(portable, 'idms2'), { recursive: true })
    for (const file of ['settings.json', 'downloads.json']) {
      const src = join(def, 'idms2', file)
      if (existsSync(src)) copyFileSync(src, join(portable, 'idms2', file))
    }
  } catch (err) {
    console.error('[userData] taşıma başarısız', err)
  }
  app.setPath('userData', portable)
}

/**
 * Yakalanmamış hataları kullanıcıya göster.
 *
 * Uygulama hazır olduktan sonra oluşan hatalar (ör. bir torrent eklenirken
 * webtorrent içinde fırlayan hata) başlangıç hatası değildir; pencere açılmış
 * ve uygulama çalışmaya devam ediyordur. Başlık buna göre ayrılır, aksi hâlde
 * kullanıcı “IDMS başlatılamadı” diyerek uygulamanın açılmadığını sanır.
 */
function reportStartupError(error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  const running = app.isReady()
  const title = running ? 'IDMS: beklenmeyen hata' : 'IDMS başlatılamadı'
  const intro = running
    ? 'Hata kaydedildi; uygulama çalışmaya devam ediyor:'
    : 'Başlangıç hatası kaydedildi:'
  try {
    const log = join(app.getPath('userData'), 'idms2-startup.log')
    appendFileSync(log, `[${new Date().toISOString()}] ${detail}\n`, 'utf8')
    dialog.showErrorBox(title, `${intro}\n${log}\n\n${detail}`)
  } catch (logError) {
    dialog.showErrorBox(title, `${detail}\n\nHata kaydı yazılamadı: ${String(logError)}`)
  }
}

process.on('uncaughtException', reportStartupError)
process.on('unhandledRejection', reportStartupError)

resolveUserDataDir()

// ---------------------------------------------------------------------------
// Tek örnek kilidi: ikinci kopya açılırsa mevcut pencereyi öne getir
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let win: BrowserWindow | null = null
const pendingRendererEvents: Array<{ channel: string; payload: unknown }> = []
let tray: Tray | null = null
let store: Store
let manager: DownloadManager
let notifier: Notifier
let extServer: ExtensionServer
let torrentMgr: TorrentManager
let locator: ToolLocator
let ytdlp: YtdlpRunner
let floatService: FloatService
let downloadWindows: DownloadWindows
let stopScheduler: (() => void) | null = null
let clipboardTimer: ReturnType<typeof setInterval> | null = null

/** İndirme durumlarının son görülen hâli: ilerleme penceresini yalnızca geçişte aç. */
const lastStates = new Map<string, DownloadState>()

const toasts: AppToast[] = []

// ---------------------------------------------------------------------------
// Windows ile başlat
// ---------------------------------------------------------------------------

/**
 * "Windows ile başlat" ayarını işletim sistemine uygular. Windows'ta
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run kaydı oluşturulur/silinir.
 * Geliştirme modunda çalıştırılabilir dosya electron.exe olduğu için uygulama
 * dizini de argüman olarak eklenir; paketlenmiş sürümde yalnızca IDMS.exe yazılır.
 */
function applyStartOnBoot(startOnBoot: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  try {
    const args = app.isPackaged ? ['--autostart'] : [app.getAppPath(), '--autostart']
    app.setLoginItemSettings({
      openAtLogin: startOnBoot,
      enabled: startOnBoot,
      path: process.execPath,
      args
    })
    const applied = app.getLoginItemSettings({ path: process.execPath, args })
    if (applied.openAtLogin !== startOnBoot) {
      console.warn('[startOnBoot] kayıt uygulanamadı', applied)
    } else {
      console.log('[startOnBoot]', startOnBoot ? 'açık' : 'kapalı')
    }
  } catch (e) {
    console.error('[startOnBoot]', e)
  }
}

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
    title: 'IDMS',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'resources', 'icon.png'),
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
    // "Simge durumunda başlat": pencereyi göstermeden tepsiden devam et
    if (settings.general.startMinimized) {
      win?.hide()
    } else {
      win?.show()
    }
    flushPendingRendererEvents()

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
    if (win.webContents.isLoading()) {
      pendingRendererEvents.push({ channel, payload })
      return
    }
    win.webContents.send(channel, payload)
    return
  }
  pendingRendererEvents.push({ channel, payload })
}

function flushPendingRendererEvents(): void {
  if (!win || win.isDestroyed() || win.webContents.isLoading()) return
  for (const event of pendingRendererEvents.splice(0)) {
    win.webContents.send(event.channel, event.payload)
  }
}

function isTorrentFile(item: DownloadItem): boolean {
  const hasTorrentExtension = (value: string | undefined): boolean => {
    if (!value) return false
    const clean = value.split(/[?#]/, 1)[0].replace(/\\/g, '/')
    return clean.toLowerCase().endsWith('.torrent')
  }
  return hasTorrentExtension(item.name) || hasTorrentExtension(item.savePath) || hasTorrentExtension(item.url)
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
    void requestDownloadFlow({ url })
  })

  notifier.on('retry', ({ id }: { id: string }) => {
    const item = manager.get(id)
    // Medya kaydı HTTP motoruna düşmemeli: yt-dlp yeniden koşar
    if (item?.kind === 'media') return retryMediaDownload(item)
    if (item?.kind === 'torrent') return void resumeTorrent(item)
    manager.start(id)
  })
}

// ---------------------------------------------------------------------------
// İndirme yaşam döngüsü → bildirim + eklenti durumu
// ---------------------------------------------------------------------------
function wireManager(): void {
  manager.on('downloads', (items: DownloadItem[]) => {
    sendToRenderer('downloads', items)
    extServer.broadcastStatus()
    syncDownloadWindows(items)
  })

  manager.on('progress', (item: DownloadItem) => {
    sendToRenderer('progress', item)
    downloadWindows?.pushDownload(item.id)
    if (item.state === 'downloading') notifier.notifyProgress(item)
  })

  manager.on('completed', (item: DownloadItem) => {
    sendToRenderer('item', item)
    downloadWindows?.closeProgress(item.id)

    // .torrent dosyası indiğinde içeriği için onay penceresi aç. Bu durumda
    // "indirme tamamlandı" penceresi/bildirimi gösterilmez: kullanıcı doğrudan
    // torrent içeriği kararını görsün, iki pencere üst üste binmesin.
    const askTorrent =
      item.kind !== 'torrent' &&
      store.getSettings().general.confirmTorrentAfterDownload === true &&
      isTorrentFile(item) &&
      existsSync(item.savePath)

    if (askTorrent) {
      downloadWindows?.closeComplete(item.id)
      const fresh = !win || win.isDestroyed()
      revealMainWindow()
      // Pencere yeniden açıldıysa arayüz abone olmadan olay kaybolmasın:
      // sendToRenderer yükleme sırasında kuyruklar, yine de kısa gecikme ekle.
      setTimeout(() => sendToRenderer('torrent-file-complete', item), fresh ? 1200 : 60)
      return
    }

    notifier.notifyComplete(item)
    if (store.getSettings().notifications.completeWindow !== false) {
      downloadWindows?.openComplete(item.id)
    } else {
      downloadWindows?.closeComplete(item.id)
    }
  })

  manager.on('download-error', (item: DownloadItem) => {
    notifier.notifyError(item)
    sendToRenderer('item', item)
    downloadWindows?.pushDownload(item.id)
  })

  // "İndirmeden önce" bildirimi: onay modu açıksa istek anında toast göster
  manager.on('confirm-required', (item: DownloadItem) => {
    notifier.notifyStart(item, true)
  })
}

/**
 * Durum değişimlerinde IDM pencerelerini yönetir: indirme başlarken ilerleme
 * penceresi, iptalde kapanış. Tamamlanma penceresi `completed` olayında açılır.
 */
function syncDownloadWindows(items: DownloadItem[]): void {
  if (!downloadWindows) return
  const settings = store.getSettings()
  for (const item of items) {
    const prev = lastStates.get(item.id)
    if (item.state === 'downloading' && prev !== 'downloading') {
      if (settings.notifications.progressWindow !== false) {
        downloadWindows.openProgress(item.id)
      }
    }
    if (item.state === 'canceled' && prev !== 'canceled') {
      downloadWindows.closeProgress(item.id)
    }
    if (item.state !== 'completed') downloadWindows.pushDownload(item.id)
    lastStates.set(item.id, item.state)
  }
  // Listedeki kayıtlar silinmiş olabilir (temizleme/kaldırma)
  for (const id of [...lastStates.keys()]) {
    if (!items.some((i) => i.id === id)) {
      lastStates.delete(id)
      downloadWindows.closeProgress(id)
      downloadWindows.closeComplete(id)
    }
  }
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
      // Panodan gelen düz yazıları ve kopyalanan kod/metin bloklarındaki URL'leri yoksay.
      // Yalnızca tek başına geçerli HTTP(S) adresi bildirim üretir.
      if (/\s/.test(text)) return
      let parsed: URL
      try {
        parsed = new URL(text)
      } catch {
        return
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) return
      if (parsed.username || parsed.password) return
      const normalizedUrl = parsed.href
      // Aynı URL zaten listede mi?
      const exists = manager.list().some((d) => {
        try {
          return new URL(d.url).href === normalizedUrl
        } catch {
          return d.url === text
        }
      })
      if (exists) return
      notifier.notifyClipboard(normalizedUrl)
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

  // Yüzen IDMS paneli artık sayfanın içinde çizilir; uygulama yalnızca
  // kalite listesini ve indirme eylemlerini sağlar (bkz. floatService.ts).
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
    // Dosya gerçekten bu klasöre yazılacak (adı yt-dlp tamamlayınca belli olur)
    savePath: join(saveDir, item.name),
    media: {
      site: hostOf(req.url),
      wantedQuality: quality,
      formatId: req.formatId
    }
  })

  const created = manager.get(item.id)
  if (created) notifier.notifyStart(created, false)
  sendToRenderer('extension-event', { type: 'download-requested', url: req.url })

  runMediaDownload(item.id, req, saveDir, quality)
  return { id: item.id }
}

/**
 * yt-dlp'yi bir kayıt için koşar. İlk indirme ve "yeniden dene" aynı yolu
 * kullanır; böylece başarısız bir medya kaydı HTTP motoruna düşmez.
 */
function runMediaDownload(
  id: string,
  req: MediaDownloadRequest,
  saveDir: string,
  quality: 'best' | 'audio',
  forceOverwrite = false
): void {
  if (mediaControllers.has(id)) return
  const settings = store.getSettings()
  const controller = new AbortController()
  mediaControllers.set(id, controller)

  manager.externalStarted(id)

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
          impersonate: settings.social.impersonate,
          forceOverwrite
        },
        {
          onStart: () => manager.externalStarted(id),
          onProgress: (p) => {
            const totalBytes = p.totalBytes && p.totalBytes > 0 ? p.totalBytes : 0
            manager.externalProgress(id, {
              percent: p.percent,
              speed: p.speed,
              etaSeconds: p.etaSeconds,
              // Gerçek akış boyutu biliniyorsa onu göster; uydurma bayt yazma
              ...(totalBytes > 0
                ? {
                    totalBytes,
                    downloadedBytes: Math.min(totalBytes, Math.round(p.percent * totalBytes))
                  }
                : {}),
              statusLine: p.statusLine
            })
          }
        },
        controller.signal
      )
      manager.externalComplete(id, result.filePath)
    } catch (e: any) {
      const msg = e?.message || t('err.generic')
      if (msg.includes('iptal')) {
        // Duraklatma da süreci sonlandırır; durumu manager belirlediyse koru
        if (manager.get(id)?.state === 'downloading') manager.externalState(id, 'canceled')
      } else {
        // Bilinen yt-dlp hataları (oturum, erişim, istek sınırı) çevrilmiş görünür
        const known = classifyProbeError(msg)
        manager.externalError(id, known ? mediaErrorNote(msg) : msg)
      }
    } finally {
      mediaControllers.delete(id)
    }
  })()
}

/** Başarısız/duraklatılmış medya indirmesini aynı kayıt üzerinde yeniden koşar. */
function retryMediaDownload(item: DownloadItem): void {
  const settings = store.getSettings()
  const quality = item.media?.wantedQuality || settings.social.preferredQuality
  const saveDir = join(settings.general.downloadDir, quality === 'audio' ? 'audio' : 'video')

  // Hatalı denemede geride kalan bozuk parça dosyaları varsa baştan indir
  const forceOverwrite = item.state === 'error'

  manager.patchItem(item.id, {
    errorMessage: undefined,
    finishedAt: undefined,
    progress: {
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      etaSeconds: null,
      connections: 0
    }
  })

  runMediaDownload(
    item.id,
    {
      url: item.url,
      pageUrl: item.pageUrl,
      quality,
      formatId: item.media?.formatId,
      silent: true
    },
    saveDir,
    quality,
    forceOverwrite
  )
}

const mediaControllers = new Map<string, AbortController>()

/**
 * Eski sürüm, birleştirme sonrası silinen parça dosyasının yolunu (ör.
 * "Video.f251.webm") kaydetmişti. Tamamlanmış medya kaydında dosya yoksa aynı
 * klasördeki gerçek çıktıyı (Video.mkv/mp4/mp3…) bulup kaydı düzeltir.
 */
async function repairMediaPaths(mgr: DownloadManager): Promise<void> {
  for (const item of mgr.list()) {
    if (item.kind !== 'media' || item.state !== 'completed' || !item.savePath) continue
    if (existsSync(item.savePath)) continue

    const dir = dirname(item.savePath)
    const file = basename(item.savePath)
    // "Ad.f251.webm" → "Ad"; tek parçalı indirmede yalnızca uzantı atılır
    const stem = file.replace(/\.f[\w-]+\.[^.]+$/, '').replace(/\.[^.]+$/, '')
    if (!stem) continue
    // Uygulama adı sadeleştirirken "|" gibi karakterleri boşluğa çeviriyor,
    // yt-dlp ise "｜" yazıyor: harf/rakam dışını atarak karşılaştır.
    const target = stem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    if (!target) continue

    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      continue
    }

    let best: { path: string; size: number; mtime: number } | null = null
    for (const f of entries) {
      if (/\.(part|ytdl|temp)$/i.test(f)) continue
      if (/\.f[\w-]+\.[^.]+$/i.test(f)) continue
      const nameStem = f.replace(/\.[^.]+$/, '')
      if (nameStem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') !== target) continue
      const p = join(dir, f)
      try {
        const st = await fsp.stat(p)
        if (!st.isFile()) continue
        // Birleştirme çıktısı en son yazılan dosyadır
        if (!best || st.mtimeMs > best.mtime) best = { path: p, size: st.size, mtime: st.mtimeMs }
      } catch {
        /* yoksay */
      }
    }
    if (!best) continue

    mgr.patchItem(item.id, {
      savePath: best.path,
      name: basename(best.path),
      category: categoryForFilename(basename(best.path)),
      progress: {
        ...item.progress,
        percent: 1,
        totalBytes: best.size,
        downloadedBytes: best.size
      }
    })
  }
}

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
        cookies: m.cookies,
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
 * Panelin kalite listesi: ekstraktör sitelerinde (Reddit, YouTube…) oynatıcının
 * tek `<source>`'u tam listeyi vermez; önce yt-dlp biçimleri denenir, olmazsa
 * oynatıcının `<source>` seçeneklerine düşülür. Diğer sayfalarda kaynaklar
 * varsa doğrudan onlar kullanılır (yt-dlp beklemesi yok).
 */
async function floatProbeFormats(m: FloatMediaInfo): Promise<FloatProbeResult> {
  const hasSources = Array.isArray(m.sources) && m.sources.length > 0
  const hasYtdlp = !!locator.findYtdlp()
  const audioExtract = hasYtdlp && !!locator.findFfmpeg()

  /** Oynatıcının kendi listesi: hızlı yol, yt-dlp beklemesi yok. */
  const fromSources = async (): Promise<FloatProbeResult> => {
    const formats = formatsFromSources(m, { audioExtract })
    if (!formats.length) return { ok: false, formats: [], note: t('float.noFormats') }
    // Boyutlar oynatıcıdan gelmez: HEAD ile Content-Length sorgulanır.
    return { ok: true, formats: await fillFormatSizes(formats, { pageUrl: m.pageUrl }) }
  }

  // Oynatıcının indirdiği HLS/DASH manifesti: kaliteler ve ayrı ses akışı
  // orada listelenir (Reddit tek bir mp4 <source> gösterir). Manifest kendi
  // başına çözülebildiği için sayfa oturumu gerekmez.
  const manifest = typeof m.manifest === 'string' ? m.manifest.trim() : ''
  if (
    hasYtdlp &&
    /^https?:\/\//i.test(manifest) &&
    (m.needsExtractor || !hasSources || m.sources!.length <= 1)
  ) {
    const probed = await runProbe(manifest, manifest, m.cookies)
    if (probed.formats.length) return probed
  }

  // Doğrudan dosya / çoklu <source>: hızlı yol, yt-dlp beklemesi yok
  if (!hasSources && isDirectMedia(m)) return fromSources()

  const target =
    m.needsExtractor || !/^https?:\/\//i.test(m.url) ? m.pageUrl || m.url : m.url
  const targetOk = /^https?:\/\//i.test(target)

  // Ekstraktör sitesinde oynatıcı genellikle tek kopya sunar (Reddit'in
  // doğrudan mp4'ü); tam kalite + ses listesi için önce yt-dlp denenir.
  // Çözülemezse oynatıcının kaynaklarına düşülür.
  if (hasSources) {
    const probeTarget = probeFirstTarget(m)
    if (probeTarget && hasYtdlp) {
      const probed = await runProbe(probeTarget, undefined, m.cookies)
      if (probed.formats.length) return probed
    }
    return fromSources()
  }

  if (!targetOk) {
    return { ok: false, formats: [], note: t('float.unsupported') }
  }
  // Ana sayfa, keşfet veya profil gibi liste sayfalarını yt-dlp çözemez
  // ("Unsupported URL"); ham hata yerine kısa bir yönlendirme gösterilir.
  if (isGenericPage(target)) {
    return { ok: false, formats: [], note: t('float.pageNotSpecific') }
  }
  if (!hasYtdlp) return { ok: false, formats: [], note: t('float.needYtdlp') }

  return runProbe(target, undefined, m.cookies)
}

/**
 * yt-dlp biçim listesini panel satırlarına çevirir (hata kısa nota dönüşür).
 * `sourceUrl` verilirse satırlar o adresi taşır: HLS/DASH manifesti doğrudan
 * indirilir, sayfa oturumu yeniden çözülmez.
 */
async function runProbe(
  target: string,
  sourceUrl?: string,
  cookies?: FloatMediaInfo['cookies']
): Promise<FloatProbeResult> {
  try {
    const settings = store.getSettings()
    const probe = await withTimeout(
      ytdlp.probe({
        url: target,
        cookies,
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
    return {
      ok: true,
      formats: sourceUrl
        ? formats.map((f) => ({
            ...f,
            // Kalite kimliği manifest içinde aranır (formatId), adres manifesttir
            url: sourceUrl
          }))
        : formats
    }
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
    case 'rateLimit':
      return t('float.rateLimit')
    case 'unavailable':
      return t('float.unavailable')
    default:
      return t('float.probeFailed')
  }
}

/**
 * Medya penceresi için sürüm: giriş gerektiren içerikte çerez ayarını
 * doğrudan hatırlatır. Ham yt-dlp metni kullanıcıya gösterilmez.
 */
function mediaErrorNote(raw?: string): string {
  if (raw) console.warn('[yt-dlp] medya:', raw)
  switch (classifyProbeError(raw)) {
    case 'login':
      return t('media.needsCookies')
    case 'unsupported':
      return t('float.pageNotSpecific')
    case 'rateLimit':
      return t('float.rateLimit')
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
    const created = win
    created?.once('ready-to-show', () => {
      created.show()
      created.focus()
    })
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/* ------------------------------------------------------------------------- */
/* IDM tarzı indirme pencereleri                                             */
/* ------------------------------------------------------------------------- */

/** Ana pencereden veya kısayoldan "Dosya İndirme Bilgisi" penceresini açar. */
async function openAddDownloadWindow(url?: string): Promise<void> {
  const request: DownloadWindowRequest = { url: (url || '').trim(), start: true }
  const existing = request.url ? manager.findDuplicate(request.url) : undefined
  if (existing) {
    await handleDuplicate(existing, request)
    return
  }
  downloadWindows.openAdd(request)
}

/* ------------------------------------------------------------------------- */
/* Eklenti köprüsü: onay penceresinin sonucunu bekleyen istekler             */
/* ------------------------------------------------------------------------- */

type FlowResult = { id?: string } | null
interface PendingFlow {
  resolve: (r: FlowResult) => void
  timer: NodeJS.Timeout
}

/** Aynı URL / aynı mevcut kayıt için bekleyen eklenti istekleri */
const pendingAddFlows = new Map<string, PendingFlow[]>()
const pendingDupFlows = new Map<string, PendingFlow[]>()
/** Pencere kapanırken "karar verildi" sayılması gereken işlemler */
const submittingAdd = new Set<string>()
const submittingDup = new Set<string>()
/** Eklentiden gelen oturum çerezleri (yalnızca bu akış için, diske yazılmaz) */
const flowHeaders = new Map<string, Record<string, string>>()

function waitForFlow(
  map: Map<string, PendingFlow[]>,
  key: string,
  open: () => void,
  timeoutMs = 60000
): Promise<FlowResult> {
  return new Promise((resolve) => {
    const entry: PendingFlow = {
      resolve,
      timer: setTimeout(() => settleFlows(map, key, null), timeoutMs)
    }
    const list = map.get(key) || []
    list.push(entry)
    map.set(key, list)
    open()
  })
}

function settleFlows(
  map: Map<string, PendingFlow[]>,
  key: string,
  value: FlowResult
): void {
  const list = map.get(key)
  if (!list) return
  map.delete(key)
  for (const entry of list) {
    clearTimeout(entry.timer)
    entry.resolve(value)
  }
}

/**
 * Kullanıcı pencereyi kapattıysa bekleyen eklenti isteği "kabul edilmedi"
 * olarak sonlanır; eklenti tarayıcı indirmesini iptal etmez.
 */
function handleWindowClosed(ctx: DownloadWindowContext): void {
  if (ctx.mode === 'add') {
    if (submittingAdd.has(ctx.request.url)) return
    settleFlows(pendingAddFlows, ctx.request.url, null)
    return
  }
  if (ctx.mode === 'duplicate') {
    if (submittingDup.has(ctx.existingId)) return
    settleFlows(pendingDupFlows, ctx.existingId, null)
    settleFlows(pendingAddFlows, ctx.request.url, null)
  }
}

/**
 * Renderer'a gönderilen ayarlar: eşleştirme token'ı ve izinli kökenler ana
 * süreçte kalır (UI bunlara ihtiyaç duymaz).
 */
function publicSettings(): Settings {
  const s = store.getSettings()
  return { ...s, extension: { ...s.extension, token: '', allowedOrigins: [] } }
}

/**
 * Pano/eklenti gibi dış kaynaklardan gelen indirme isteği. Aynı URL varsa
 * "Aynı indirme bağlantısı" penceresi, onay ayarı açıksa "Dosya İndirme
 * Bilgisi" penceresi gösterilir; aksi hâlde doğrudan kuyruğa eklenir.
 *
 * `awaitDecision` yalnızca eklenti köprüsünde true'dur: tarayıcı indirmesinin
 * iptal edilip edilmeyeceğine karar vermek için kullanıcının penceredeki
 * seçimi beklenir. Aksi hâlde pencere açılır açılmaz `null` dönülür.
 */
async function requestDownloadFlow(
  req: AddDownloadRequest,
  awaitDecision = false
): Promise<{ id?: string } | null> {
  const settings = store.getSettings()
  const request: DownloadWindowRequest = {
    url: req.url,
    pageUrl: req.pageUrl,
    name: req.name,
    savePath: req.savePath,
    category: req.category,
    description: req.description,
    silent: req.silent,
    start: true
  }
  if (req.headers && Object.keys(req.headers).length > 0) {
    flowHeaders.set(req.url, req.headers)
    const timer = setTimeout(() => flowHeaders.delete(req.url), 10 * 60 * 1000)
    timer.unref?.()
  }

  const existing = manager.findDuplicate(req.url)
  if (existing) {
    const policy = settings.general.duplicatePolicy || 'ask'
    if (policy === 'ask' && awaitDecision) {
      return waitForFlow(pendingDupFlows, existing.id, () =>
        downloadWindows.openDuplicate(existing.id, request)
      )
    }
    const item = await handleDuplicate(existing, request)
    return item ? { id: item.id } : null
  }

  if (settings.general.confirmBeforeDownload && !req.silent) {
    if (!awaitDecision) {
      downloadWindows.openAdd(request)
      return null
    }
    return waitForFlow(pendingAddFlows, request.url, () => downloadWindows.openAdd(request))
  }

  const item = await createDownload(request, true)
  return { id: item.id }
}

/** Ekleme penceresinden gelen onay: kaydı oluşturur veya aynı URL'yi sorar. */
async function submitAdd(
  request: DownloadWindowRequest,
  start: boolean
): Promise<DownloadItem | null> {
  const next: DownloadWindowRequest = { ...request, silent: true, start }
  const existing = manager.findDuplicate(next.url)
  if (existing) {
    const item = await handleDuplicate(existing, next)
    // Politika "ask" ise seçim penceresi açıldı; karar orada verilir.
    if (item) settleFlows(pendingAddFlows, next.url, { id: item.id })
    return item
  }
  const item = await createDownload(next, start)
  settleFlows(pendingAddFlows, next.url, { id: item.id })
  return item
}

async function createDownload(
  request: DownloadWindowRequest,
  start: boolean
): Promise<DownloadItem> {
  const headers = flowHeaders.get(request.url)
  flowHeaders.delete(request.url)
  const item = await manager.add({
    url: request.url,
    pageUrl: request.pageUrl,
    name: request.name,
    savePath: request.savePath,
    category: request.category,
    description: request.description,
    silent: true,
    start,
    headers
  })
  if (start) manager.start(item.id)
  return item
}

/** Aynı URL politikasını uygular; "ask" ise seçim penceresini açar. */
async function handleDuplicate(
  existing: DownloadItem,
  request: DownloadWindowRequest
): Promise<DownloadItem | null> {
  const policy = store.getSettings().general.duplicatePolicy || 'ask'
  if (policy === 'ask') {
    downloadWindows.openDuplicate(existing.id, request)
    return null
  }
  return resolveDuplicate(policy, existing, request)
}

async function resolveDuplicate(
  policy: 'number' | 'overwrite' | 'continue',
  existing: DownloadItem,
  request: DownloadWindowRequest
): Promise<DownloadItem | null> {
  const start = request.start !== false

  if (policy === 'continue') {
    // Tamamlanmış kayıt: IDM bitiş penceresini gösterir
    if (existing.state === 'completed') {
      downloadWindows.openComplete(existing.id)
      return existing
    }
    if (existing.kind === 'media') {
      if (existing.state !== 'downloading') retryMediaDownload(existing)
    } else if (existing.state !== 'downloading' && existing.state !== 'resolving') {
      manager.start(existing.id)
    }
    downloadWindows.openProgress(existing.id)
    return existing
  }

  if (policy === 'overwrite') {
    // Mevcut dosyayı ve kaydı kaldır, aynı yola yeniden indir
    lastStates.delete(existing.id)
    try {
      manager.remove(existing.id, true)
    } catch {
      /* kayıt zaten yok */
    }
    downloadWindows.closeProgress(existing.id)
    downloadWindows.closeComplete(existing.id)
    return createDownload(
      {
        ...request,
        name: existing.name,
        savePath: existing.savePath,
        category: request.category || existing.category
      },
      start
    )
  }

  // Numaralı kopya: dosya adı "ad (1).uzantı" olur
  const base = request.savePath || existing.savePath
  return createDownload({ ...request, savePath: numberedPath(base) }, start)
}

/** Diskte/aktif kayıtlarda çakışmayan numaralı bir yol üretir. */
function numberedPath(p: string): string {
  const free = uniquePath(p)
  if (free !== p) return free
  const ext = extname(p)
  const stem = basename(p, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dirname(p), `${stem} (${i})${ext}`)
    if (existsSync(candidate)) continue
    if (manager.list().some((it) => it.savePath === candidate)) continue
    return candidate
  }
  return join(dirname(p), `${stem} (${Date.now()})${ext}`)
}

/** Windows "Birlikte aç" penceresi; diğer platformlarda varsayılan uygulama. */
function openWith(p: string): void {
  if (process.platform === 'win32') {
    try {
      spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', p], {
        detached: true,
        stdio: 'ignore'
      }).unref()
      return
    } catch {
      /* aşağıdaki yola düş */
    }
  }
  void shell.openPath(p)
}

/** Paketlenmiş uygulamada `resources/extension`, geliştirmede proje kökü. */
function extensionRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'extension')
    : join(app.getAppPath(), 'extension')
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

  ipcMain.handle('settings:get', () => publicSettings())

  ipcMain.handle('settings:patch', (_e, patch: DeepPartial<Settings>) => {
    // Token ve izinli kökenler yalnızca ana süreçte yönetilir; renderer'dan
    // yazılamaz (yanlışlıkla/kötüye kullanımda eşleşme sessizce bozulmasın).
    if (patch.extension) {
      delete (patch.extension as any).token
      delete (patch.extension as any).allowedOrigins
    }
    const before = store.getSettings()
    const next = store.patchSettings(patch as Partial<Settings>)
    setLanguage(next.general.language)
    locator?.updateSettings(next)

    // Windows ile başlat: ayar değiştiyse işletim sistemi kaydını güncelle
    if (patch.general?.startOnBoot !== undefined) {
      applyStartOnBoot(next.general.startOnBoot)
    }

    // Eklenti sunucusu yaşam döngüsü
    if (patch.extension && extServer) {
      // Panel ayarı değiştiyse önce açık sekmelere haber ver (sunucu kapanınca
      // WebSocket bağlantısı kesilir ve içerik betiği haberi alamaz).
      extServer.broadcastConfig()
      if (!next.extension.enabled) void extServer.stop()
      else void extServer.start()
    }
    // Pano izleme
    if (patch.general && next.general.monitorClipboard && !clipboardTimer) {
      startClipboardMonitor()
    }
    void before
    sendToRenderer('settings', publicSettings())
    downloadWindows?.pushAll()
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

  ipcMain.handle('shell:openPath', (_e, p: string) => {
    // Kayıtlı yol silinmiş olabilir (ör. birleştirme sonrası parça dosyası);
    // Windows "dosya bulunamadı" penceresi yerine klasörü aç.
    if (existsSync(p)) return shell.openPath(p)
    return shell.openPath(dirname(p))
  })
  ipcMain.handle('shell:showItemInFolder', (_e, p: string) => {
    if (existsSync(p)) return shell.showItemInFolder(p)
    return shell.openPath(dirname(p))
  })
  ipcMain.handle('ext:dir', () => extensionRoot())

  /* --- Firefox / Zen (Gecko) kalıcı eklenti kurulumu --- */
  ipcMain.handle('ext:gecko:list', () => listGeckoProfiles())
  ipcMain.handle('ext:gecko:install', (_e, profileDir: string): GeckoInstallResult => {
    const target = listGeckoProfiles().find((p) => pathsEqual(p.profileDir, profileDir))
    if (!target) return { ok: false, error: 'Profil bulunamadı' }
    try {
      installGeckoExtension(target.profileDir, join(extensionRoot(), 'gecko'))
      return { ok: true, running: target.running }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('ext:gecko:uninstall', (_e, profileDir: string): GeckoInstallResult => {
    const target = listGeckoProfiles().find((p) => pathsEqual(p.profileDir, profileDir))
    if (!target) return { ok: false, error: 'Profil bulunamadı' }
    try {
      uninstallGeckoExtension(target.profileDir)
      return { ok: true, running: target.running }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('shell:openExternal', (_e, u: string) => shell.openExternal(u))
  ipcMain.handle('shell:openWith', (_e, p: string) => {
    openWith(p)
  })

  /* --- IDM tarzı indirme pencereleri --- */
  ipcMain.handle('dlwin:openAdd', (_e, url?: string) => openAddDownloadWindow(url))

  // Listeden çift tıklama: indirme ayrıntı/ilerleme panelini aç
  ipcMain.handle('dlwin:openProgress', (_e, id: string) => {
    const item = manager.get(id)
    if (!item) return false
    downloadWindows.openProgress(item.id)
    return true
  })

  ipcMain.handle('dlwin:state', (e) => {
    const ctx = downloadWindows.contextFor(e.sender.id)
    return ctx ? downloadWindows.stateFor(ctx) : null
  })

  ipcMain.handle('dlwin:action', async (e, action: DownloadWindowAction) => {
    const ctx = downloadWindows.contextFor(e.sender.id)
    if (!ctx) return null

    switch (action.type) {
      case 'add-start':
      case 'add-later': {
        const start = action.type === 'add-start'
        // "Bu kategori için bu yolu hatırla" (pencere ayrıca kendisi de yazar)
        if (action.remember && action.request.savePath && action.request.category) {
          const current = store.getSettings()
          store.patchSettings({
            general: {
              categoryDirs: {
                ...(current.general.categoryDirs || {}),
                [action.request.category]: dirname(action.request.savePath)
              }
            }
          })
          sendToRenderer('settings', publicSettings())
          downloadWindows.pushAll()
        }
        submittingAdd.add(action.request.url)
        downloadWindows.closeForWebContents(e.sender.id)
        try {
          await submitAdd(action.request, start)
        } catch (err: any) {
          settleFlows(pendingAddFlows, action.request.url, null)
          dialog.showErrorBox(t('common.error'), String(err?.message || err))
        } finally {
          submittingAdd.delete(action.request.url)
        }
        break
      }

      case 'add-cancel':
        if (ctx.mode !== 'add') break
        settleFlows(pendingAddFlows, ctx.request.url, null)
        downloadWindows.closeForWebContents(e.sender.id)
        break

      case 'progress-pause': {
        if (ctx.mode !== 'progress') break
        const item = manager.get(ctx.itemId)
        if (item?.kind === 'media') mediaControllers.get(item.id)?.abort()
        // Torrent'ler HTTP motorunda değil; asıl trafiği webtorrent taşır
        if (item?.kind === 'torrent') pauseTorrentFor(item.id)
        try {
          manager.pause(ctx.itemId)
        } catch {
          /* kayıt kaldırılmış */
        }
        break
      }

      case 'progress-resume': {
        if (ctx.mode !== 'progress') break
        const item = manager.get(ctx.itemId)
        if (!item) break
        if (item.kind === 'media') retryMediaDownload(item)
        else if (item.kind === 'torrent') void resumeTorrent(item)
        else manager.resume(item.id)
        break
      }

      case 'progress-cancel': {
        if (ctx.mode !== 'progress') break
        mediaControllers.get(ctx.itemId)?.abort()
        if (manager.get(ctx.itemId)?.kind === 'torrent') pauseTorrentFor(ctx.itemId)
        try {
          manager.cancel(ctx.itemId)
        } catch {
          /* kayıt kaldırılmış */
        }
        downloadWindows.closeProgress(ctx.itemId)
        break
      }

      case 'progress-open-file': {
        if (ctx.mode !== 'progress') break
        const item = manager.get(ctx.itemId)
        if (!item?.savePath) break
        // Dosya yerinde yoksa klasörünü aç (silinmiş/taşınmış olabilir)
        await shell.openPath(existsSync(item.savePath) ? item.savePath : dirname(item.savePath))
        break
      }

      case 'progress-open-folder': {
        if (ctx.mode !== 'progress') break
        const item = manager.get(ctx.itemId)
        if (!item?.savePath) break
        if (existsSync(item.savePath)) shell.showItemInFolder(item.savePath)
        else await shell.openPath(dirname(item.savePath))
        break
      }

      case 'set-speed-limit': {
        store.patchSettings({
          general: { speedLimitMbps: Math.max(0, Number(action.mbps) || 0) }
        })
        sendToRenderer('settings', publicSettings())
        downloadWindows.pushAll()
        break
      }

      case 'set-complete-window': {
        store.patchSettings({
          notifications: { completeWindow: action.value }
        })
        sendToRenderer('settings', publicSettings())
        downloadWindows.pushAll()
        break
      }

      case 'complete-open':
      case 'complete-open-with':
      case 'complete-folder':
      case 'complete-close': {
        if (ctx.mode !== 'complete') break
        if (action.dontShowAgain) {
          store.patchSettings({
            notifications: { completeWindow: false }
          })
          sendToRenderer('settings', publicSettings())
          downloadWindows.pushAll()
        }
        downloadWindows.closeComplete(ctx.itemId)
        break
      }

      case 'duplicate-choose': {
        if (ctx.mode !== 'duplicate') break
        if (action.remember) {
          store.patchSettings({
            general: { duplicatePolicy: action.choice }
          })
          sendToRenderer('settings', publicSettings())
          downloadWindows.pushAll()
        }
        submittingDup.add(ctx.existingId)
        downloadWindows.closeForWebContents(e.sender.id)
        const existing = manager.get(ctx.existingId)
        if (!existing) {
          settleFlows(pendingDupFlows, ctx.existingId, null)
          settleFlows(pendingAddFlows, ctx.request.url, null)
          submittingDup.delete(ctx.existingId)
          break
        }
        try {
          const item = await resolveDuplicate(action.choice, existing, ctx.request)
          const result: FlowResult = item ? { id: item.id } : null
          settleFlows(pendingDupFlows, ctx.existingId, result)
          settleFlows(pendingAddFlows, ctx.request.url, result)
        } catch (err: any) {
          settleFlows(pendingDupFlows, ctx.existingId, null)
          settleFlows(pendingAddFlows, ctx.request.url, null)
          dialog.showErrorBox(t('common.error'), String(err?.message || err))
        } finally {
          submittingDup.delete(ctx.existingId)
        }
        break
      }

      case 'duplicate-cancel':
        if (ctx.mode !== 'duplicate') break
        settleFlows(pendingDupFlows, ctx.existingId, null)
        settleFlows(pendingAddFlows, ctx.request.url, null)
        downloadWindows.closeForWebContents(e.sender.id)
        break
    }
    return null
  })

  ipcMain.handle('downloads:list', () => manager.list())

  ipcMain.handle('downloads:probe', async (_e, url: string, pageUrl?: string) =>
    probeUrl(url, { pageUrl })
  )

  ipcMain.handle('downloads:add', async (_e, req: AddDownloadRequest) => {
    const res = await requestDownloadFlow(req)
    const item = res?.id ? manager.get(res.id) : undefined
    return { id: item?.id, state: item?.state }
  })

  ipcMain.handle('downloads:start', (_e, id: string) => {
    const item = manager.get(id)
    // Medya kayıtları HTTP motoruna düşmemeli: yt-dlp yeniden koşar
    if (item?.kind === 'media') return retryMediaDownload(item)
    // Torrent kayıtları da HTTP motoruna girmemeli: webtorrent tarafını sürdür
    if (item?.kind === 'torrent') return resumeTorrent(item)
    manager.start(id)
  })
  ipcMain.handle('downloads:pause', (_e, id: string) => {
    mediaControllers.get(id)?.abort()
    // Torrent'ler HTTP motorunda değil; webtorrent tarafını da durdur
    pauseTorrentFor(id)
    manager.pause(id)
  })
  ipcMain.handle('downloads:queue', (_e, id: string) => {
    const item = manager.get(id)
    // Medya indirmeleri HTTP kuyruğuna girmez
    if (item?.kind === 'media') return item
    // Torrent'ler kuyruğa alınmaz: kuyruk = duraklat (aksini yaparsak pompa
    // magnet adresini HTTP ile indirmeye çalışır)
    if (item?.kind === 'torrent') {
      pauseTorrentFor(id)
      manager.pause(id)
      return manager.get(id) ?? item
    }
    return manager.queue(id)
  })
  ipcMain.handle('downloads:resume', async (_e, id: string) => {
    const item = manager.get(id)
    if (!item) return
    if (item.kind === 'media') return retryMediaDownload(item)
    if (item.kind === 'torrent') return resumeTorrent(item)
    manager.resume(id)
  })
  ipcMain.handle('downloads:cancel', (_e, id: string) => {
    mediaControllers.get(id)?.abort()
    // Torrent: trafiği kes ama kaydı koru (sonra devam edilebilsin)
    pauseTorrentFor(id)
    manager.cancel(id)
  })
  ipcMain.handle('downloads:remove', (_e, id: string, deleteFile: boolean) => {
    mediaControllers.get(id)?.abort()
    const torrentId = torrentIdFor(id)
    if (torrentId) {
      torrentLinks.delete(torrentId)
      // Dizin silme/istemci bırakma torrent tarafında yapılır
      void torrentMgr.remove(torrentId, deleteFile)
    }
    return manager.remove(id, deleteFile)
  })
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
  ipcMain.handle('media:probe', async (_e, url: string, _pageUrl?: string, cookies?: any[]) => {
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
    const res = await ytdlp.probe({
      url,
      cookies,
      useCookies: settings.social.passCookies,
      impersonate: settings.social.impersonate
    })
    // Ham yt-dlp metni arayüze çıkmasın; nota çevir, aslını günlüğe yaz
    if (!res.ok && res.error) return { ...res, error: mediaErrorNote(res.error) }
    return res
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
    sendToRenderer('settings', publicSettings())
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
    // Aynı torrent zaten ekliyse yeni kayıt açma; mevcut indirmeyi döndür
    if (res.duplicate) {
      const existingId = torrentLinks.get(res.id)
      if (existingId) return { id: existingId, torrentId: res.id, duplicate: true }
    }
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
    return { id: item.id, torrentId: res.id, duplicate: false }
  })

  /** .torrent dosyasını çöz: onay penceresinde gerçek içerik adı/boyutu görünsün. */
  ipcMain.handle('torrent:inspect', async (_e, filePath: string) => {
    try {
      if (!filePath || !existsSync(filePath)) {
        return { ok: false as const, error: 'torrent file not found' }
      }
      const { default: parseTorrent } = await import('parse-torrent')
      const parsed = await parseTorrent(await fsp.readFile(filePath))
      return {
        ok: true as const,
        name: parsed.name || '',
        totalBytes: parsed.length || 0,
        files: (parsed.files || []).map((f) => ({ name: f.name, length: f.length }))
      }
    } catch (e: any) {
      return { ok: false as const, error: e?.message || String(e) }
    }
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

/** İndirme kaydından ona bağlı torrent kimliğini bulur. */
function torrentIdFor(downloadId: string): string | undefined {
  for (const [torrentId, linkedId] of torrentLinks) {
    if (linkedId === downloadId) return torrentId
  }
  return undefined
}

/** İndirmeye bağlı torrent varsa webtorrent tarafını duraklat. */
function pauseTorrentFor(downloadId: string): void {
  const torrentId = torrentIdFor(downloadId)
  if (torrentId) torrentMgr.pause(torrentId)
}

/**
 * Torrent indirmesini sürdürür. Kayıt tamamlanmışsa yalnızca seed edilir;
 * istemcide torrent yoksa (uygulama yeniden açıldı) yeniden eklenir.
 */
async function resumeTorrent(item: DownloadItem): Promise<void> {
  const torrentId = torrentIdFor(item.id)
  if (item.state === 'completed') {
    if (torrentId) torrentMgr.resume(torrentId)
    return
  }
  if (torrentId) {
    torrentMgr.resume(torrentId)
  } else {
    const source = item.torrent?.magnetOrPath || item.url
    const dir = item.savePath ? dirname(item.savePath) : undefined
    const added = await torrentMgr.add(source, dir)
    torrentLinks.set(added.id, item.id)
  }
  // HTTP motorunu başlatma; durumu doğrudan 'downloading' yap
  manager.externalStarted(item.id)
}

// ---------------------------------------------------------------------------
// Torrent olaylarını indirme listesine yansıt
// ---------------------------------------------------------------------------
function wireTorrents(): void {
  torrentMgr.on('progress', (torrentId: string, snap: any) => {
    const dlId = torrentLinks.get(torrentId)
    if (!dlId) return
    // Önce torrent alanlarını yaz: externalProgress kaydı arayüze yayınlıyor,
    // eş/hız bilgisi yayından sonra yazılırsa arayüzde eski değer kalır.
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
    // Paketli sürümde simge process.resourcesPath altına kopyalanır
    // (extraResources); geliştirmede depodaki resources/icon.png kullanılır.
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'resources', 'icon.png')
    const img = existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty()
    tray = new Tray(img)
    tray.setToolTip('IDMS — ' + t('app.tagline'))
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
if (gotLock) app.whenReady().then(async () => {
  store = new Store()
  setLanguage(store.getSettings().general.language)
  applyStartOnBoot(store.getSettings().general.startOnBoot)
  registerMagnetProtocol()

  manager = new DownloadManager(store)
  notifier = new Notifier(store)
  downloadWindows = new DownloadWindows({
    store,
    manager,
    preload: join(__dirname, '../preload/index.mjs'),
    rendererFile: join(__dirname, '../renderer/download.html'),
    onClosed: handleWindowClosed
  })
  torrentMgr = new TorrentManager(store)
  locator = new ToolLocator(store.getSettings())
  ytdlp = new YtdlpRunner(locator, join(app.getPath('userData'), 'idms2', 'tmp'))

  floatService = new FloatService({
    store,
    download: floatDownload,
    probeFormats: floatProbeFormats,
    openFormats: floatOpenFormats,
    showMainWindow: revealMainWindow
  })
  extServer = new ExtensionServer(
    store,
    manager,
    (req) => requestDownloadFlow(req, true),
    floatService,
    (req) =>
      startMediaDownload({
        url: req.url,
        pageUrl: req.pageUrl,
        quality: req.quality as MediaDownloadRequest['quality'],
        cookies: req.cookies
      }),
    app.getVersion()
  )

  wireNotifier()
  wireManager()
  wireExtensionMedia()
  wireTorrents()
  registerIpc()
  await repairMediaPaths(manager)

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
    // Zaten indiriliyor: yeni kayıt açmadan pencereyi öne getir
    if (res.duplicate) {
      if (win) win.show()
      return
    }
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

app.on('window-all-closed', () => {
  // Tepsi simgesi varsa uygulama arka planda kalır: arka plan indirmeleri ve
  // eklenti köprüsü pencere kapalıyken de çalışmaya devam etmeli. Çıkış için
  // tepsi menüsündeki "Çıkış" kullanılır. Tepsi oluşturulamadıysa eski
  // davranış (kapatınca çık) korunur.
  if (!tray) app.quit()
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
    manager.persistNow()
    await torrentMgr.shutdown()
  } catch (err) {
    console.error('[quit]', err)
  } finally {
    app.exit(0)
  }
})
