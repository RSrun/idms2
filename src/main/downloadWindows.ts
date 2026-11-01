import { BrowserWindow, nativeTheme } from 'electron'
import type {
  DownloadItem,
  DownloadWindowMode,
  DownloadWindowRequest,
  DownloadWindowSegment,
  DownloadWindowState
} from '@shared/types'
import type { Store } from './store'
import type { DownloadManager } from './engine/manager'
import { t } from './lang'

export type DownloadWindowContext =
  | { mode: 'add'; request: DownloadWindowRequest }
  | { mode: 'progress'; itemId: string }
  | { mode: 'complete'; itemId: string }
  | { mode: 'duplicate'; existingId: string; request: DownloadWindowRequest }

interface WindowOptions {
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  resizable?: boolean
}

const WINDOW_SIZE: Record<DownloadWindowMode, WindowOptions> = {
  add: { width: 690, height: 360, minWidth: 620, minHeight: 330, resizable: true },
  progress: { width: 600, height: 570, minWidth: 520, minHeight: 420, resizable: true },
  complete: { width: 510, height: 300, resizable: false },
  duplicate: { width: 520, height: 340, resizable: false }
}

/**
 * IDM'nin dört ayrı penceresi:
 *  - add       → indirmeden önce "Dosya İndirme Bilgisi"
 *  - progress  → indirme sırasında ilerleme / bağlantılar
 *  - complete  → indirme sonunda "İndirme tamamlandı"
 *  - duplicate → aynı bağlantı tekrar eklenince seçim penceresi
 *
 * Her pencere kendi BrowserWindow'udur; içerik `download.html` sayfasıdır.
 * Durum, pencere kimliğine (webContents.id) göre çözülür; böylece IPC
 * çağrıları hangi pencereden geldiğini bilir.
 */
export class DownloadWindows {
  private store: Store
  private manager: DownloadManager
  private preload: string
  private rendererFile: string
  private contexts = new Map<number, DownloadWindowContext>()
  private byKey = new Map<string, BrowserWindow>()
  private onClosed?: (ctx: DownloadWindowContext) => void

  constructor(opts: {
    store: Store
    manager: DownloadManager
    preload: string
    rendererFile: string
    /** Pencere kullanıcı tarafından kapatıldığında (karar verilmeden) çağrılır */
    onClosed?: (ctx: DownloadWindowContext) => void
  }) {
    this.store = opts.store
    this.manager = opts.manager
    this.preload = opts.preload
    this.rendererFile = opts.rendererFile
    this.onClosed = opts.onClosed
  }

  /* ------------------------------------------------------------------ */
  /* Açma                                                               */
  /* ------------------------------------------------------------------ */

  openAdd(request: DownloadWindowRequest): BrowserWindow {
    return this.open({ mode: 'add', request }, `add:${request.url}`, request)
  }

  openProgress(itemId: string): BrowserWindow {
    return this.open({ mode: 'progress', itemId }, `progress:${itemId}`)
  }

  openComplete(itemId: string): BrowserWindow {
    return this.open({ mode: 'complete', itemId }, `complete:${itemId}`)
  }

  openDuplicate(existingId: string, request: DownloadWindowRequest): BrowserWindow {
    return this.open(
      { mode: 'duplicate', existingId, request },
      `duplicate:${existingId}`,
      request
    )
  }

  private open(
    ctx: DownloadWindowContext,
    key: string,
    request?: DownloadWindowRequest
  ): BrowserWindow {
    const existing = this.byKey.get(key)
    if (existing && !existing.isDestroyed()) {
      this.contexts.set(existing.webContents.id, ctx)
      this.reveal(existing)
      this.pushTo(existing, ctx)
      return existing
    }

    const size = WINDOW_SIZE[ctx.mode]
    const settings = this.store.getSettings()
    const dark =
      settings.general.theme === 'dark' ||
      (settings.general.theme === 'system' && prefersDark())
    const win = new BrowserWindow({
      ...size,
      show: false,
      title: this.titleFor(ctx),
      backgroundColor: dark ? '#202124' : '#f0f1f3',
      autoHideMenuBar: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      useContentSize: true,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    })

    const wcId = win.webContents.id
    this.contexts.set(wcId, ctx)
    this.byKey.set(key, win)

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      this.reveal(win)
      this.pushTo(win, ctx)
    })

    // Sayfanın <title>'ı pencere başlığını ezmesin: başlık her modda
    // uygulamanın diline ve indirme yüzdesine göre main süreçte belirlenir.
    win.on('page-title-updated', (event) => {
      event.preventDefault()
      if (!win.isDestroyed()) win.setTitle(this.titleFor(ctx))
    })

    win.on('closed', () => {
      const current = this.contexts.get(wcId) || ctx
      this.contexts.delete(wcId)
      if (this.byKey.get(key) === win) this.byKey.delete(key)
      try {
        this.onClosed?.(current)
      } catch {
        /* dinleyici hatası pencere kapanışını etkilemesin */
      }
    })

    const query: Record<string, string> = { mode: ctx.mode }
    if (request?.url) query.url = request.url
    if (ctx.mode === 'progress' || ctx.mode === 'complete') query.id = ctx.itemId
    if (ctx.mode === 'duplicate') query.id = ctx.existingId

    if (process.env.ELECTRON_RENDERER_URL) {
      const qs = new URLSearchParams(query).toString()
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/download.html?${qs}`)
    } else {
      void win.loadFile(this.rendererFile, { query })
    }
    return win
  }

  /**
   * İndirme penceresini öne getirir. Windows, arka plandaki bir uygulamanın
   * pencereyi öne almasını engelleyebildiği için pencere kısa süreliğine
   * always-on-top yapılır; böylece odak isteği reddedilse bile pencere
   * görünür kalır. Odak alınamazsa görev çubuğu düğmesi yanıp söner.
   */
  private reveal(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    const wasTop = win.isAlwaysOnTop()
    win.setAlwaysOnTop(true, 'floating')
    win.show()
    win.moveTop()
    win.focus()
    win.webContents.focus()
    setTimeout(() => {
      if (win.isDestroyed()) return
      win.setAlwaysOnTop(wasTop)
      if (win.isFocused()) return
      win.flashFrame(true)
      const stop = (): void => {
        if (!win.isDestroyed()) win.flashFrame(false)
      }
      win.once('focus', stop)
      setTimeout(stop, 5000)
    }, 400)
  }

  /* ------------------------------------------------------------------ */
  /* Durum / güncelleme                                                 */
  /* ------------------------------------------------------------------ */

  contextFor(webContentsId: number): DownloadWindowContext | undefined {
    return this.contexts.get(webContentsId)
  }

  windowFor(webContentsId: number): BrowserWindow | undefined {
    for (const win of this.byKey.values()) {
      if (!win.isDestroyed() && win.webContents.id === webContentsId) return win
    }
    return undefined
  }

  stateFor(ctx: DownloadWindowContext): DownloadWindowState {
    const settings = this.store.getSettings()
    const base: DownloadWindowState = { mode: ctx.mode, settings }
    if (ctx.mode === 'add') return { ...base, request: ctx.request }
    if (ctx.mode === 'duplicate') {
      return {
        ...base,
        request: ctx.request,
        existing: this.manager.get(ctx.existingId)
      }
    }
    const item = this.manager.get(ctx.itemId)
    if (!item) return base
    if (ctx.mode === 'complete') return { ...base, item }
    return { ...base, item, segments: this.segmentsFor(item) }
  }

  private segmentsFor(item: DownloadItem): DownloadWindowSegment[] {
    const raw = this.manager.snapshotSegments(item.id)
    if (!raw.length) return []
    const total = item.progress.totalBytes
    return raw.map((s) => {
      const unknown = s.end === Number.MAX_SAFE_INTEGER
      const size = unknown ? Math.max(0, total - s.start) : s.end - s.start + 1
      const done = unknown
        ? item.state === 'completed'
        : s.start + s.received > s.end
      return {
        index: s.index,
        start: s.start,
        end: s.end,
        received: s.received,
        size,
        done
      }
    })
  }

  /** Tek bir pencereye güncel durumu gönder. */
  pushTo(win: BrowserWindow, ctx: DownloadWindowContext): void {
    if (win.isDestroyed()) return
    try {
      win.webContents.send('dlwin:update', this.stateFor(ctx))
      win.setTitle(this.titleFor(ctx))
    } catch {
      /* pencere kapanıyor */
    }
  }

  /** Bir indirmeye bağlı tüm pencereleri güncelle. */
  pushDownload(itemId: string): void {
    for (const [wcId, ctx] of this.contexts) {
      const matches =
        (ctx.mode === 'progress' || ctx.mode === 'complete') && ctx.itemId === itemId
      if (!matches) continue
      const win = this.windowFor(wcId)
      if (win) this.pushTo(win, ctx)
    }
  }

  /** Tüm pencereleri güncelle (dil/tema/ayar değişti). */
  pushAll(): void {
    for (const [wcId, ctx] of this.contexts) {
      const win = this.windowFor(wcId)
      if (win) this.pushTo(win, ctx)
    }
  }

  closeProgress(itemId: string): void {
    this.closeKey(`progress:${itemId}`)
  }

  closeComplete(itemId: string): void {
    this.closeKey(`complete:${itemId}`)
  }

  closeAdd(url?: string): void {
    if (url) this.closeKey(`add:${url}`)
  }

  closeDuplicate(existingId: string): void {
    this.closeKey(`duplicate:${existingId}`)
  }

  closeForWebContents(webContentsId: number): void {
    const win = this.windowFor(webContentsId)
    if (win && !win.isDestroyed()) win.close()
  }

  private closeKey(key: string): void {
    const win = this.byKey.get(key)
    if (win && !win.isDestroyed()) win.close()
    this.byKey.delete(key)
  }

  private titleFor(ctx: DownloadWindowContext): string {
    if (ctx.mode === 'add') return t('win.add.title')
    if (ctx.mode === 'duplicate') return t('win.duplicate.title')
    if (ctx.mode === 'complete') return t('win.complete.title')
    const item = this.manager.get(ctx.itemId)
    if (!item) return t('win.progress.title')
    return `${Math.round(item.progress.percent * 100)}% ${item.name}`
  }
}

function prefersDark(): boolean {
  try {
    return nativeTheme.shouldUseDarkColors
  } catch {
    return false
  }
}
