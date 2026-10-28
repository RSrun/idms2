import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import type {
  FloatAction,
  FloatFormat,
  FloatFormatsState,
  FloatMediaInfo,
  FloatPanelState,
  FloatScreenRect
} from '@shared/types'
import type { FloatProbeResult } from './floatFormats'
import type { Store } from './store'

/** Panelin iki hâli: küçük "IDMS" rozeti ve açılmış kart. */
const COLLAPSED = { width: 118, height: 34 }
const EXPANDED_WIDTH = 348

/**
 * Açık kartın yüksekliği, listelenen kalite/ses satırlarına göre hesaplanır.
 * Değerler float.css ile bire bir aynı olmalı (kenarlık + başlık + dolgu + alt satır).
 */
const CARD_BASE = 77
const ROW_H = 24
const SEC_H = 15
const MIN_EXPANDED = 118
const MAX_EXPANDED = 360

/** Panel medyanın sağ üst köşesine bu kadar içeriden yerleşir. */
const OFFSET = 12

export interface FloatPanelPayload {
  state: 'show' | 'update' | 'hide'
  key?: string
  media?: FloatMediaInfo
  rect?: FloatScreenRect
}

export interface FloatPanelDeps {
  store: Store
  /** Seçilen kalite/ses satırını indirir (format yoksa en iyi kalite) */
  download: (
    media: FloatMediaInfo,
    kind: 'video' | 'audio',
    format?: FloatFormat
  ) => Promise<{ ok: boolean; message?: string }>
  /** Video kalitelerini ve ses dosyalarını hazırlar */
  probeFormats: (media: FloatMediaInfo) => Promise<FloatProbeResult>
  /** Format seçim penceresini ana pencerede açar */
  openFormats: (media: FloatMediaInfo) => void
  /** Ana pencereyi öne getirir */
  showMainWindow: () => void
}

/**
 * IDM'nin yüzen paneli gibi: video/ses oynarken tarayıcı penceresinin
 * üzerinde, her zaman en üstte duran küçük bir IDMS rozeti. Rozete
 * tıklayınca indirme seçenekleri açılır; odağı çalmaz.
 */
export class FloatPanel {
  private win: BrowserWindow | null = null
  private deps: FloatPanelDeps
  private media: FloatMediaInfo | null = null
  private key = ''
  private rect: FloatScreenRect | null = null
  private expanded = false
  private dismissedKey = ''
  private visible = false
  private ready = false
  private ipcDone = false
  /** Kullanıcı kartı açıkken gelen "gizle" isteği, kart kapanınca uygulanır. */
  private pendingHide = false

  /** Panelde listelenen video kaliteleri ve ses dosyaları */
  private formats: FloatFormat[] = []
  private formatsState: FloatFormatsState = 'idle'
  private formatsNote = ''
  /** Medya anahtarına göre kalite sonuçları (aynı video tekrar açılınca beklemesin) */
  private probeCache = new Map<string, FloatProbeResult>()
  private probeRunning = false
  private probeQueued = false

  constructor(deps: FloatPanelDeps) {
    this.deps = deps
    this.registerIpc()
  }

  get isEnabled(): boolean {
    const ext = this.deps.store.getSettings().extension
    return ext.enabled && ext.floatingPanel !== false
  }

  /** Eklentiden gelen panel bildirimini işler. */
  handle(payload: FloatPanelPayload): void {
    if (!this.isEnabled) {
      this.hide(true)
      return
    }
    const key = payload.key || payload.media?.url || ''

    if (payload.state === 'hide') {
      if (!key || key === this.key) {
        this.dismissedKey = ''
        // Kart açıkken gizleme isteği paneli kullanıcının elinden çekmesin.
        if (this.expanded) {
          this.pendingHide = true
          return
        }
        this.hide(false)
      }
      return
    }
    if (!payload.media || !payload.rect) return
    if (key && key === this.dismissedKey) return

    const isNew = !this.media || key !== this.key
    if (isNew) {
      this.media = payload.media
      this.key = key
      this.rect = payload.rect
      this.expanded = false
      this.pendingHide = false
      this.dismissedKey = ''
      this.show()
      return
    }

    this.media = payload.media
    const moved = this.rectMoved(payload.rect)
    this.rect = payload.rect
    if (!this.visible) {
      this.show()
      return
    }
    if (moved) this.place()
    if (payload.state === 'show') this.pushState()
  }

  private rectMoved(next: FloatScreenRect): boolean {
    const prev = this.rect
    if (!prev) return true
    return (
      Math.abs(prev.x - next.x) > 4 ||
      Math.abs(prev.y - next.y) > 4 ||
      Math.abs(prev.width - next.width) > 4 ||
      Math.abs(prev.height - next.height) > 4
    )
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    this.ready = false
    const win = new BrowserWindow({
      ...this.sizeFor(false),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setMenuBarVisibility(false)

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/float.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/float.html'))
    }

    win.webContents.on('did-finish-load', () => {
      this.ready = true
      this.pushState()
    })

    win.on('closed', () => {
      this.win = null
      this.ready = false
      this.visible = false
    })

    this.win = win
    return win
  }

  private sizeFor(expanded: boolean): { width: number; height: number } {
    if (!expanded) return { ...COLLAPSED }
    return { width: EXPANDED_WIDTH, height: this.expandedHeight() }
  }

  /** Kart yüksekliği: kalite satırları çoğaldıkça büyür (en fazla MAX_EXPANDED). */
  private expandedHeight(): number {
    const ready = this.formatsState === 'ready' && this.formats.length > 0
    const rows = ready ? this.formats.length : 1
    const sections = ready ? new Set(this.formats.map((f) => f.kind)).size : 0
    const height = CARD_BASE + sections * SEC_H + rows * ROW_H
    return Math.max(MIN_EXPANDED, Math.min(MAX_EXPANDED, height))
  }

  private bounds(): { x: number; y: number; width: number; height: number } {
    const size = this.sizeFor(this.expanded)
    const rect = this.rect
    if (!rect) {
      const area = screen.getPrimaryDisplay().workArea
      return {
        x: area.x + area.width - size.width - 24,
        y: area.y + 24,
        ...size
      }
    }

    const anchorRight = rect.x + rect.width
    const anchorTop = rect.y
    // Rozet videonun içinde kalsın: video rozetten darsa ortalanır, aksi
    // hâlde sağ üst köşeye yaslanır.
    let x: number
    if (rect.width >= size.width + 8) {
      x = Math.round(Math.min(anchorRight - size.width - OFFSET, rect.x + rect.width - size.width - 2))
      x = Math.max(rect.x + 2, x)
    } else {
      x = Math.round(rect.x + (rect.width - size.width) / 2)
    }
    let y = Math.round(anchorTop + OFFSET)
    // Kısa videolarda rozet alt kenardan taşmasın (kart açıkken büyüyebilir).
    if (!this.expanded && rect.height >= size.height + 8) {
      y = Math.min(y, Math.round(rect.y + rect.height - size.height - 2))
    }

    const display = screen.getDisplayNearestPoint({
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2)
    })
    const area = display.workArea
    x = Math.max(area.x + 4, Math.min(area.x + area.width - size.width - 4, x))
    y = Math.max(area.y + 4, Math.min(area.y + area.height - size.height - 4, y))
    return { x, y, ...size }
  }

  private place(): void {
    if (!this.win || this.win.isDestroyed()) return
    const b = this.bounds()
    this.win.setBounds(b)
  }

  private show(): void {
    if (!this.media) return
    const win = this.ensureWindow()
    this.place()
    this.visible = true
    this.pendingHide = false
    if (!win.isVisible()) win.showInactive()
    else win.setAlwaysOnTop(true, 'screen-saver')
    // Rozet görünür görünmez kaliteler hazırlanır; kullanıcı rozete
    // tıkladığında liste çoğunlukla hazır olur.
    this.loadFormats()
    this.pushState()
  }

  hide(force: boolean): void {
    if (force) {
      this.media = null
      this.rect = null
      this.key = ''
      this.dismissedKey = ''
      this.resetFormats()
    }
    this.visible = false
    this.expanded = false
    this.pendingHide = false
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide()
      this.win.setBounds({ ...this.bounds(), ...this.sizeFor(false) })
    }
  }

  /** Ayar kapatıldığında paneli tamamen kaldırır. */
  destroy(): void {
    this.hide(true)
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return
    this.expanded = expanded
    if (!this.visible) return
    // Kart kapanınca bekletilen gizleme isteği uygulanır (video duraklatıldıysa).
    if (!expanded && this.pendingHide) {
      this.hide(false)
      return
    }
    // Liste henüz gelmediyse kart açılırken istek yenilenir.
    if (expanded && this.formatsState === 'idle') this.loadFormats()
    this.place()
    this.pushState()
  }

  /* ---- kalite listesi ---- */

  private resetFormats(): void {
    this.formats = []
    this.formatsState = 'idle'
    this.formatsNote = ''
  }

  private loadFormats(): void {
    if (!this.media || !this.key) return
    const key = this.key
    const cached = this.probeCache.get(key)
    if (cached) {
      this.applyFormats(cached)
      return
    }
    this.formats = []
    this.formatsState = 'loading'
    this.formatsNote = ''
    if (this.probeRunning) {
      this.probeQueued = true
      return
    }
    void this.runProbe(key, this.media)
  }

  private async runProbe(key: string, media: FloatMediaInfo): Promise<void> {
    this.probeRunning = true
    let res: FloatProbeResult
    try {
      res = await this.deps.probeFormats(media)
    } catch (err: any) {
      res = { ok: false, formats: [], note: String(err?.message || err) }
    } finally {
      this.probeRunning = false
    }
    this.rememberProbe(key, res)
    if (key === this.key) this.applyFormats(res)
    if (this.probeQueued) {
      this.probeQueued = false
      this.loadFormats()
    }
  }

  private rememberProbe(key: string, res: FloatProbeResult): void {
    if (this.probeCache.has(key)) this.probeCache.delete(key)
    this.probeCache.set(key, res)
    // Bellek sınırsız büyümesin: en eski girdiler düşer.
    while (this.probeCache.size > 24) {
      const oldest = this.probeCache.keys().next().value
      if (oldest === undefined) break
      this.probeCache.delete(oldest)
    }
  }

  private applyFormats(res: FloatProbeResult): void {
    this.formats = res.formats
    this.formatsState = res.ok ? (res.formats.length ? 'ready' : 'empty') : 'error'
    this.formatsNote = res.note || ''
    // Satır sayısı değişti → açık kartın yüksekliği yeniden hesaplanır.
    if (this.expanded) this.place()
    this.pushState()
  }

  private snapshot(): FloatPanelState {
    return {
      media: this.media,
      expanded: this.expanded,
      language: this.deps.store.getSettings().general.language,
      formats: this.formats,
      formatsState: this.formatsState,
      formatsNote: this.formatsNote
    }
  }

  private pushState(): void {
    if (!this.win || this.win.isDestroyed() || !this.ready) return
    this.win.webContents.send('float:media', this.snapshot())
  }

  private status(message: string, tone: 'info' | 'error' | 'success'): void {
    if (!this.win || this.win.isDestroyed() || !this.ready) return
    this.win.webContents.send('float:status', { message, tone })
  }

  private registerIpc(): void {
    if (this.ipcDone) return
    this.ipcDone = true

    const fromFloat = (e: Electron.IpcMainInvokeEvent): boolean =>
      !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents

    ipcMain.handle('float:state', (e) => {
      if (!fromFloat(e)) return null
      return this.snapshot()
    })

    ipcMain.handle('float:action', async (e, action: FloatAction) => {
      if (!fromFloat(e) || !action || typeof action.type !== 'string') {
        return { ok: false }
      }
      try {
        switch (action.type) {
          case 'expand':
            this.setExpanded(true)
            return { ok: true }
          case 'collapse':
            this.setExpanded(false)
            return { ok: true }
          case 'close':
            this.dismissedKey = this.key
            this.hide(false)
            return { ok: true }
          case 'open-app':
            this.deps.showMainWindow()
            return { ok: true }
          case 'formats': {
            if (this.media) this.deps.openFormats(this.media)
            return { ok: true }
          }
          case 'download-video':
          case 'download-audio': {
            if (!this.media) return { ok: false }
            const kind = action.type === 'download-audio' ? 'audio' : 'video'
            const res = await this.deps.download(this.media, kind)
            if (res.ok) {
              this.status(res.message || '', 'success')
              setTimeout(() => this.hide(false), 1800)
            } else {
              this.status(res.message || '', 'error')
            }
            return res
          }
          case 'download-format': {
            if (!this.media || typeof action.formatId !== 'string') return { ok: false }
            const format = this.formats.find((f) => f.formatId === action.formatId)
            if (!format) return { ok: false, message: this.formatsNote }
            const res = await this.deps.download(this.media, format.kind, format)
            if (res.ok) {
              this.status(res.message || '', 'success')
              setTimeout(() => this.hide(false), 1800)
            } else {
              this.status(res.message || '', 'error')
            }
            return res
          }
          default:
            return { ok: false }
        }
      } catch (err: any) {
        this.status(String(err?.message || err), 'error')
        return { ok: false, message: String(err?.message || err) }
      }
    })
  }
}
