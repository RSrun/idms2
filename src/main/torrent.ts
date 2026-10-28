import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync, promises as fsp } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import WebTorrent from 'webtorrent'
import type { DownloadItem } from '@shared/types'
import type { Store } from './store'

type Torrent = ReturnType<WebTorrent['add']>

interface ActiveTorrent {
  id: string
  torrent: Torrent
  savePath: string
  magnetOrPath: string
}

/**
 * webtorrent tabanlı torrent alt sistemi.
 * - Magnet veya .torrent dosyası ekler
 * - Kaydetme klasörü, eş sayısı, hız, oran bilgisini günceller
 * - seedRatioLimit'e ulaşınca bırakır (kapatırken tamamen bırakır)
 */
export class TorrentManager extends EventEmitter {
  private client: WebTorrent | null = null
  private active = new Map<string, ActiveTorrent>()
  private store: Store
  private removeTimer: ReturnType<typeof setInterval> | null = null

  constructor(store: Store) {
    super()
    this.setMaxListeners(50)
    this.store = store
  }

  private ensureClient(): WebTorrent {
    if (this.client) return this.client
    const cfg = this.store.getSettings().torrent
    this.client = new WebTorrent({
      dht: cfg.dht,
      utp: cfg.utp,
      lsd: true,
      natUpnp: true,
      natPmp: true,
      torrentPort: cfg.port || 0,
      dhtPort: 0
    })
    this.client.on('error', (err: any) => {
      this.emit('error', err?.message || String(err))
    })
    return this.client
  }

  get running(): number {
    return this.active.size
  }

  /**
   * Torrent ekler; başarı durumunda indirme kimliğini döndürür.
   * savePath verilmezse ayarlardaki klasör kullanılır.
   */
  async add(magnetOrPath: string, savePath?: string): Promise<{ id: string }> {
    const cfg = this.store.getSettings().torrent
    const dir = savePath || cfg.saveDir
    await fsp.mkdir(dir, { recursive: true })

    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    let input: string | Buffer = magnetOrPath.trim()
    if (!/^magnet:\?/i.test(input) && existsSync(String(input))) {
      input = readFileSync(String(input))
    } else if (!/^magnet:\?/i.test(String(input)) && !/^https?:\/\//i.test(String(input))) {
      // magnet değil ve dosya değil: muhtemelen geçersiz
      if (!String(input)) throw new Error('geçersiz torrent girdisi')
    }

    const client = this.ensureClient()

    const torrent = await new Promise<Torrent>((resolve, reject) => {
      const t = client.add(input as any, { path: dir }, (ready) => {
        if (ready) resolve(t)
      })
      t.on('error', (err: any) => reject(err instanceof Error ? err : new Error(String(err))))
      // magnet metadata bekleme: hazır olduğunda resolve et; hata da olabilir
      t.on('metadata', () => resolve(t))
      // metadata'sız da olsa devam (bazı istemciler ready vermez)
      setTimeout(() => resolve(t), 30000)
    })

    // İlerleme yayınlarını dinle
    const entry: ActiveTorrent = { id, torrent, savePath: dir, magnetOrPath: String(magnetOrPath) }
    this.active.set(id, entry)

    torrent.on('download', () => this.emit('progress', id, this.snapshot(entry)))
    torrent.on('upload', () => this.emit('progress', id, this.snapshot(entry)))
    torrent.on('done', () => this.emit('done', id, this.snapshot(entry)))
    torrent.on('error', (err: any) => this.emit('torrent-error', id, err?.message || String(err)))
    torrent.on('wire', () => this.emit('progress', id, this.snapshot(entry)))

    // İlk bilgi hemen yayınlansın
    setImmediate(() => this.emit('progress', id, this.snapshot(entry)))
    return { id }
  }

  private snapshot(entry: ActiveTorrent): Partial<DownloadItem['torrent']> & { name: string; progress: number } {
    const t = entry.torrent
    return {
      name: t.name || 'torrent',
      progress: t.progress || 0,
      peers: t.numPeers || 0,
      downloadSpeed: t.downloadSpeed || 0,
      uploadSpeed: t.uploadSpeed || 0,
      ratio: t.ratio || 0,
      totalBytes: t.length || 0,
      downloadedBytes: Math.round((t.progress || 0) * (t.length || 0))
    }
  }

  getSnapshot(id: string): ReturnType<TorrentManager['snapshot']> | null {
    const entry = this.active.get(id)
    return entry ? this.snapshot(entry) : null
  }

  name(id: string): string | null {
    const entry = this.active.get(id)
    return entry ? entry.torrent.name || null : null
  }

  pause(id: string): void {
    this.active.get(id)?.torrent.pause()
    this.emit('progress', id, this.snapshot(this.active.get(id)!))
  }

  resume(id: string): void {
    const entry = this.active.get(id)
    if (!entry) return
    entry.torrent.resume()
    this.emit('progress', id, this.snapshot(entry))
  }

  /** Torrenti listeden kaldır; deleteData=true ise dosyaları da siler. */
  async remove(id: string, deleteData: boolean): Promise<void> {
    const entry = this.active.get(id)
    if (!entry) return
    this.active.delete(id)
    await new Promise<void>((resolve) => {
      entry.torrent.destroy({ destroyStore: deleteData }, () => resolve())
      setTimeout(resolve, 3000)
    })
    if (deleteData) {
      try {
        await fsp.rm(join(entry.savePath, entry.torrent.name || ''), {
          recursive: true,
          force: true
        })
      } catch {
        /* yoksay */
      }
    }
  }

  /** seedRatioLimit'e ulaşanları bırak, işleri izle */
  tick(): void {
    const limit = this.store.getSettings().torrent.seedRatioLimit
    for (const [id, entry] of this.active) {
      if (limit > 0 && entry.torrent.done && entry.torrent.ratio >= limit) {
        entry.torrent.pause()
        this.emit('seed-limit', id, this.snapshot(entry))
      }
    }
  }

  startTicking(): void {
    if (this.removeTimer) return
    this.removeTimer = setInterval(() => this.tick(), 5000)
  }

  /** Uygulama kapanırken tüm torrentleri bırak (verify dosyayı kaybetmeden) */
  async shutdown(): Promise<void> {
    if (this.removeTimer) clearInterval(this.removeTimer)
    const entries = [...this.active.values()]
    this.active.clear()
    await Promise.all(
      entries.map(
        (e) =>
          new Promise<void>((resolve) => {
            try {
              e.torrent.destroy({ destroyStore: false }, () => resolve())
            } catch {
              resolve()
            }
            setTimeout(resolve, 2000)
          })
      )
    )
    await new Promise<void>((resolve) => {
      if (!this.client) return resolve()
      try {
        this.client.destroy(() => resolve())
      } catch {
        resolve()
      }
      setTimeout(resolve, 2000)
    })
    this.client = null
  }
}

/** Magnet protokolünü uygulamaya bağla (Windows kayıt girdisi) */
export function registerMagnetProtocol(): void {
  if (process.platform === 'win32' && app.isPackaged) {
    const exe = process.execPath
    const args = process.argv.slice(1)
    app.setAsDefaultProtocolClient('magnet', exe, args)
  }
}
