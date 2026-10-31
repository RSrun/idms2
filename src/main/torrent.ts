import { EventEmitter } from 'events'
import { existsSync, readFileSync, promises as fsp } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import WebTorrent from 'webtorrent'
import type { DownloadItem } from '@shared/types'
import type { Store } from './store'

type Torrent = ReturnType<WebTorrent['add']>

interface ActiveTorrent {
  id: string
  torrent: Torrent
  savePath: string
  magnetOrPath: string
  /** Uygulama tarafından duraklatıldı mı (webtorrent bayrağından bağımsız) */
  paused: boolean
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
   *
   * Aynı torrent zaten etkinse hata vermek yerine mevcut kayıt döner
   * (`duplicate: true`). webtorrent `Cannot add duplicate torrent …` hatası
   * fırlatır; kullanıcı aynı magnet'i ikinci kez eklediğinde bu bir hata
   * değildir.
   */
  async add(magnetOrPath: string, savePath?: string): Promise<{ id: string; duplicate: boolean }> {
    const cfg = this.store.getSettings().torrent
    const dir = savePath || cfg.saveDir
    await fsp.mkdir(dir, { recursive: true })

    let input: string | Buffer = magnetOrPath.trim()
    if (!/^magnet:\?/i.test(input) && existsSync(String(input))) {
      input = readFileSync(String(input))
    } else if (!/^magnet:\?/i.test(String(input)) && !/^https?:\/\//i.test(String(input))) {
      // magnet değil ve dosya değil: muhtemelen geçersiz
      if (!String(input)) throw new Error('geçersiz torrent girdisi')
    }

    const client = this.ensureClient()

    // Zaten etkin bir torrent mi? (çift tıklama, tekrar ekleme, protokol çağrısı)
    const existing = await this.findTorrent(client, input)
    if (existing) {
      const entry = this.entryFor(existing)
      if (entry) return { id: entry.id, duplicate: true }
      // İstemcide var ama kaydı yok (ör. yarıda kalmış ekleme): sahiplen
      return { id: this.track(existing, dir, magnetOrPath), duplicate: false }
    }

    let torrent: Torrent
    try {
      torrent = await new Promise<Torrent>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout>
        let t: Torrent
        const finish = (err?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err) reject(err)
          else resolve(t)
        }
        t = client.add(input as any, { path: dir }, (ready) => {
          if (ready) finish()
        })
        // magnet metadata bekleme: hazır olduğunda çöz; hata da olabilir
        t.on('metadata', () => finish())
        t.on('error', (err: any) => finish(err instanceof Error ? err : new Error(String(err))))
        // metadata'sız da olsa devam (bazı istemciler ready vermez)
        timer = setTimeout(() => finish(), 30000)
      })
    } catch (err) {
      // Eşzamanlı iki ekleme yarışı: ikinci istek "duplicate" alır, mevcut kayda dön
      if (/duplicate torrent/i.test(String((err as Error)?.message))) {
        const dup = await this.findTorrent(client, input)
        if (dup) {
          const entry = this.entryFor(dup)
          return { id: entry?.id ?? this.track(dup, dir, magnetOrPath), duplicate: Boolean(entry) }
        }
      }
      throw err
    }

    return { id: this.track(torrent, dir, magnetOrPath), duplicate: false }
  }

  /** İstemcideki (yok edilmemiş) eşleşen torrenti bulur. */
  private async findTorrent(client: WebTorrent, input: string | Buffer): Promise<Torrent | null> {
    try {
      const found = await client.get(input as any)
      if (!found || (found as any).destroyed) return null
      return found as Torrent
    } catch {
      return null
    }
  }

  private entryFor(torrent: Torrent): ActiveTorrent | undefined {
    for (const entry of this.active.values()) {
      if (entry.torrent === torrent) return entry
    }
    return undefined
  }

  /** Torrenti etkin listeye alır, ilerleme olaylarını bağlar. */
  private track(torrent: Torrent, savePath: string, magnetOrPath: string): string {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const entry: ActiveTorrent = { id, torrent, savePath, magnetOrPath: String(magnetOrPath), paused: false }
    this.active.set(id, entry)

    // İlerleme yayınlarını dinle
    torrent.on('download', () => this.emit('progress', id, this.snapshot(entry)))
    torrent.on('upload', () => this.emit('progress', id, this.snapshot(entry)))
    torrent.on('done', () => this.emit('done', id, this.snapshot(entry)))
    torrent.on('error', (err: any) => this.emit('torrent-error', id, err?.message || String(err)))
    torrent.on('wire', () => this.emit('progress', id, this.snapshot(entry)))

    // İlk bilgi hemen yayınlansın
    setImmediate(() => this.emit('progress', id, this.snapshot(entry)))
    return id
  }

  private snapshot(entry: ActiveTorrent): Partial<DownloadItem['torrent']> & { name: string; progress: number } {
    const t = entry.torrent
    // Duraklatılmış torrent'te webtorrent'in hız ölçerleri son 5 saniyenin
    // ortalamasını döndürür; ayrıca bağlantılar kapatıldığı için yeni olay
    // gelmez ve arayüzde donmuş bir hız kalır. Duraklatıldıysa sıfır bildir.
    const paused = entry.paused || t.paused
    return {
      name: t.name || 'torrent',
      progress: t.progress || 0,
      peers: paused ? 0 : t.numPeers || 0,
      downloadSpeed: paused ? 0 : t.downloadSpeed || 0,
      uploadSpeed: paused ? 0 : t.uploadSpeed || 0,
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

  /**
   * Torrent'i duraklat.
   *
   * webtorrent'in `pause()`'u yalnızca **yeni** eş eklenmesini engeller; açık
   * bağlantılar indirmeye/yüklemeye devam eder. Gerçekten durmak için mevcut
   * eş bağlantıları da kapatılır.
   */
  pause(id: string): void {
    const entry = this.active.get(id)
    if (!entry) return
    entry.paused = true
    entry.torrent.pause()
    this.dropWires(entry.torrent)
    this.emit('progress', id, this.snapshot(entry))
  }

  /** Duraklatılan torrent'i sürdür; tracker/DHT'e hemen yeniden duyur. */
  resume(id: string): void {
    const entry = this.active.get(id)
    if (!entry) return
    entry.paused = false
    entry.torrent.resume()
    this.reannounce(entry.torrent)
    this.emit('progress', id, this.snapshot(entry))
  }

  /** Açık eş bağlantılarını kapat (duraklatma gerçekten trafiği kessin). */
  private dropWires(torrent: Torrent): void {
    const wires = ((torrent as any).wires || []) as Array<{ destroy?: () => void }>
    for (const wire of [...wires]) {
      try {
        wire.destroy?.()
      } catch {
        /* yoksay */
      }
    }
  }

  /** Sürdürmede eş bulmayı hızlandır: tracker güncellemesi + DHT duyurusu. */
  private reannounce(torrent: Torrent): void {
    const discovery = (torrent as any).discovery
    if (!discovery) return
    try {
      discovery.tracker?.update?.()
    } catch {
      /* yoksay */
    }
    try {
      if (discovery.dht && discovery._port) {
        discovery.dht.announce(torrent.infoHash, discovery._port, () => undefined)
      }
    } catch {
      /* yoksay */
    }
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
      if (entry.paused) continue
      if (limit > 0 && entry.torrent.done && entry.torrent.ratio >= limit) {
        // Yalnızca pause() yetmez: açık eş bağlantıları da kapatılmalı
        this.pause(id)
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
