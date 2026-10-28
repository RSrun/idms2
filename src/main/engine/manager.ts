import { EventEmitter } from 'events'
import { existsSync, promises as fsp, statSync, unlinkSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type {
  CategoryId,
  DownloadItem,
  DownloadKind,
  DownloadProgress,
  DownloadState
} from '@shared/types'
import type { Store } from '../store'
import { SegmentedJob, type SegmentState } from './segment'
import { filenameFromUrl, probeUrl, sanitizeFilename } from './probe'
import { formatBytes, t } from '../lang'

const CATEGORY_BY_EXT: Record<string, CategoryId> = {
  '.mp4': 'video', '.mkv': 'video', '.avi': 'video', '.webm': 'video', '.mov': 'video',
  '.flv': 'video', '.wmv': 'video', '.m4v': 'video', '.mpg': 'video', '.mpeg': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.aac': 'audio', '.ogg': 'audio',
  '.m4a': 'audio', '.wma': 'audio', '.opus': 'audio',
  '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive',
  '.gz': 'archive', '.bz2': 'archive', '.xz': 'archive', '.iso': 'archive',
  '.exe': 'program', '.msi': 'program', '.apk': 'program', '.deb': 'program', '.rpm': 'program',
  '.dmg': 'program', '.app': 'program',
  '.pdf': 'document', '.doc': 'document', '.docx': 'document', '.xls': 'document',
  '.xlsx': 'document', '.ppt': 'document', '.pptx': 'document', '.txt': 'document',
  '.epub': 'document'
}

export function categoryForFilename(name: string): CategoryId {
  const ext = extname(name).toLowerCase()
  return CATEGORY_BY_EXT[ext] || 'other'
}

/** Uygulamanın tüm indirme yaşam döngüsünü yönetir. */
export class DownloadManager extends EventEmitter {
  private items: DownloadItem[] = []
  private jobs = new Map<string, SegmentedJob>()
  private pausedSnapshots = new Map<string, SegmentState[]>()
  private store: Store
  private pumping = false

  constructor(store: Store) {
    super()
    this.setMaxListeners(100)
    this.store = store
    this.items = store.loadDownloads()
    // Uygulama yeniden başladı: yarım kalanları "kuyruk"/"duraklatıldı" yap
    for (const it of this.items) {
      if (it.state === 'downloading' || it.state === 'resolving') {
        it.state = 'paused'
      }
      if (it.state === 'confirming') {
        it.state = 'queued'
      }
      it.progress.speed = 0
      it.progress.connections = 0
    }
  }

  list(): DownloadItem[] {
    return this.items
  }

  get(id: string): DownloadItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  /** Yeni indirme oluşturur. silent=false ise "confirming" durumunda onay bekler. */
  async add(req: {
    url: string
    pageUrl?: string
    name?: string
    savePath?: string
    category?: CategoryId
    silent?: boolean
    kind?: DownloadKind
    headers?: Record<string, string>
    totalBytes?: number | null
    supportsRange?: boolean
  }): Promise<DownloadItem> {
    const settings = this.store.getSettings()
    const id = makeId()

    let name = req.name ? sanitizeFilename(req.name) : filenameFromUrl(req.url)
    let savePath = req.savePath
    let totalBytes = req.totalBytes ?? 0
    let supportsRange = req.supportsRange ?? false

    const category = req.category || categoryForFilename(name)

    if (!savePath) {
      savePath = join(settings.general.downloadDir, category, name)
      savePath = uniquePath(savePath)
    } else {
      savePath = uniquePath(savePath)
      name = basename(savePath)
    }

    const item: DownloadItem = {
      id,
      kind: req.kind || 'http',
      name,
      url: req.url,
      pageUrl: req.pageUrl,
      savePath,
      category,
      state: 'queued',
      progress: {
        percent: 0,
        downloadedBytes: 0,
        totalBytes,
        speed: 0,
        etaSeconds: null,
        connections: 0
      },
      createdAt: Date.now()
    }
    this.items.unshift(item)

    const wantsConfirm = !req.silent && settings.general.confirmBeforeDownload
    if (wantsConfirm) {
      item.state = 'confirming'
    }

    this.persist()
    this.emitUpdate()

    // URL bilgisi yoksa arka planda çözümlenir (medya/ses için)
    if (!totalBytes) {
      void this.resolveInfo(item)
    }

    if (!wantsConfirm && settings.general.autoStart) {
      this.schedulePump()
    }
    return item
  }

  /** URL hakkında başlık/boyut/Range bilgisini arka planda çözer. */
  private async resolveInfo(item: DownloadItem): Promise<void> {
    if (this.get(item.id) !== item) return
    const prev = item.state
    if (prev === 'queued' || prev === 'confirming' || prev === 'resolving') {
      item.state = 'resolving'
      this.emitUpdate()
    }
    const probe = await probeUrl(item.url, { pageUrl: item.pageUrl })
    if (this.get(item.id) !== item) return
    if (probe.ok) {
      item.progress.totalBytes = probe.sizeBytes ?? 0
      const resolvedName = probe.name
      if (
        (!item.name || item.name === 'download') &&
        resolvedName &&
        resolvedName !== 'download'
      ) {
        item.name = resolvedName
        item.category = item.category === 'other' ? categoryForFilename(resolvedName) : item.category
        item.savePath = uniquePath(join(dirname(item.savePath), resolvedName))
      }
      this.holdRange(item, probe.supportsRange)
    }
    // Çözümleme hatası durumunda mevcut durum korunur; indirme denemesinde anlaşılır
    if (item.state === 'resolving') {
      item.state = prev === 'confirming' ? 'confirming' : 'queued'
    }
    this.persist()
    this.emitUpdate()
    if (item.state === 'queued') this.schedulePump()
  }

  private rangeSupport = new Map<string, boolean>()

  private holdRange(item: DownloadItem, supportsRange: boolean): void {
    this.rangeSupport.set(item.id, supportsRange)
  }

  private getRangeSupport(item: DownloadItem): boolean {
    return this.rangeSupport.get(item.id) ?? true // bilinmiyorsa çoklu dene
  }

  /**
   * Onay penceresinden gelen karar.
   */
  async confirm(id: string, savePath?: string, start = true): Promise<DownloadItem> {
    const item = this.must(id)
    if (savePath && savePath !== item.savePath) {
      item.savePath = savePath
      item.name = basename(savePath)
    }
    const settings = this.store.getSettings()
    item.state = 'queued'
    this.persist()
    this.emitUpdate()
    if (start && settings.general.autoStart) this.schedulePump()
    return item
  }

  start(id: string): void {
    const item = this.must(id)
    if (item.state === 'completed' || item.state === 'downloading') return
    if (item.state === 'error') {
      item.errorMessage = undefined
      item.progress.downloadedBytes = 0
      item.progress.percent = 0
    }
    item.state = 'queued'
    delete item.scheduledAt
    this.persist()
    this.emitUpdate()
    this.schedulePump()
  }

  /**
   * İndirmeyi kuyruğa alır: çalışan bir işi duraklatır, diğer durumlarda
   * durumu 'queued' yapar ve hemen başlatmaz — pompa (autoStart açıkken)
   * kuyruktan alır. Sağ tık menüsündeki "Kuyruğa ekle" için.
   */
  queue(id: string): DownloadItem {
    const item = this.must(id)
    if (item.state === 'completed' || item.state === 'confirming') return item
    if (item.state === 'downloading' || item.state === 'resolving') {
      this.pause(id)
      const p = this.must(id)
      p.state = 'queued'
      this.persist()
      this.emitUpdate()
      return p
    }
    if (item.state === 'scheduled') {
      item.state = 'queued'
      delete item.scheduledAt
    }
    if (item.state === 'error' || item.state === 'canceled') {
      item.errorMessage = undefined
    }
    item.state = 'queued'
    this.persist()
    this.emitUpdate()
    if (this.store.getSettings().general.autoStart) this.schedulePump()
    return item
  }

  pause(id: string): void {
    const item = this.must(id)
    const job = this.jobs.get(id)
    if (job) {
      const snap = job.pause()
      this.pausedSnapshots.set(id, snap)
      this.jobs.delete(id)
      item.progress.speed = 0
      item.progress.connections = 0
      // İlerlemeyi anlık snapshot'tan yaz (zamanlayıcı 400 ms gecikmeli olabilir)
      const doneBytes = snap.reduce((a, s) => a + s.received, 0)
      item.progress.downloadedBytes = doneBytes
      if (item.progress.totalBytes > 0) {
        item.progress.percent = Math.min(1, doneBytes / item.progress.totalBytes)
      }
    }
    if (item.state === 'downloading' || item.state === 'queued' || item.state === 'resolving') {
      item.state = 'paused'
      this.persist()
      this.emitUpdate()
      this.schedulePump()
    }
  }

  resume(id: string): void {
    this.start(id)
  }

  cancel(id: string): void {
    const item = this.must(id)
    const job = this.jobs.get(id)
    if (job) {
      job.cancel()
      this.jobs.delete(id)
    }
    item.state = 'canceled'
    item.progress.speed = 0
    item.progress.connections = 0
    this.persist()
    this.emitUpdate()
    this.schedulePump()
  }

  remove(id: string, deleteFile: boolean): void {
    const item = this.must(id)
    const job = this.jobs.get(id)
    if (job) {
      job.cancel()
      this.jobs.delete(id)
    }
    if (deleteFile) {
      try {
        if (existsSync(item.savePath)) unlinkSync(item.savePath)
      } catch {
        /* yoksay */
      }
    }
    this.items = this.items.filter((i) => i.id !== id)
    this.pausedSnapshots.delete(id)
    this.persist()
    this.emitUpdate()
    this.schedulePump()
  }

  schedule(id: string, at: number | null): DownloadItem {
    const item = this.must(id)
    if (at === null) {
      delete item.scheduledAt
      if (item.state === 'scheduled') item.state = 'queued'
      this.schedulePump()
    } else {
      item.scheduledAt = at
      item.state = 'scheduled'
      const job = this.jobs.get(id)
      if (job) {
        this.pausedSnapshots.set(id, job.pause())
        this.jobs.delete(id)
        item.progress.speed = 0
      }
    }
    this.persist()
    this.emitUpdate()
    return item
  }

  /** Saatlik zamanlayıcı, "scheduled" durumdakileri sıraya alır. */
  checkSchedules(): void {
    const now = Date.now()
    let changed = false
    for (const item of this.items) {
      if (item.state === 'scheduled' && item.scheduledAt && item.scheduledAt <= now) {
        delete item.scheduledAt
        item.state = 'queued'
        changed = true
      }
    }
    if (changed) {
      this.persist()
      this.emitUpdate()
      this.schedulePump()
    }
  }

  clearCompleted(): void {
    const keep = this.items.filter((i) => i.state !== 'completed')
    if (keep.length !== this.items.length) {
      this.items = keep
      this.persist()
      this.emitUpdate()
    }
  }

  /** Eklenti/bildirim için hız özeti */
  summary(): { active: number; totalSpeed: number; queued: number } {
    let speed = 0
    let active = 0
    let queued = 0
    for (const i of this.items) {
      if (i.state === 'downloading') {
        active++
        speed += i.progress.speed
      } else if (i.state === 'queued' || i.state === 'resolving') queued++
    }
    return { active, totalSpeed: speed, queued }
  }

  private must(id: string): DownloadItem {
    const item = this.get(id)
    if (!item) throw new Error('indirme bulunamadı: ' + id)
    return item
  }

  /* ------------------------------------------------------------------ */
  /* Harici işler (yt-dlp medya, torrent) için dış kapılar              */
  /* ------------------------------------------------------------------ */

  /** Harici işçinin ilerleme yayması için. */
  externalProgress(id: string, patch: Partial<DownloadProgress> & { statusLine?: string }): void {
    const item = this.get(id)
    if (!item) return
    const { statusLine, ...rest } = patch
    Object.assign(item.progress, rest)
    if (rest.totalBytes && rest.downloadedBytes !== undefined) {
      item.progress.percent = Math.min(1, rest.downloadedBytes / rest.totalBytes)
    }
    if (statusLine && item.media) item.media.statusLine = statusLine
    const now = Date.now()
    const last = this.progressThrottle.get(id) || 0
    if (now - last > 350) {
      this.progressThrottle.set(id, now)
      this.emit('progress', item)
    }
  }

  /** Harici işin başladığını bildirir (state='downloading' + startedAt). */
  externalStarted(id: string): void {
    const item = this.get(id)
    if (!item) return
    item.state = 'downloading'
    item.startedAt = item.startedAt ?? Date.now()
    this.persist()
    this.emitUpdate()
  }

  externalState(id: string, state: DownloadState, errorMessage?: string): void {
    const item = this.get(id)
    if (!item) return
    item.state = state
    if (errorMessage !== undefined) item.errorMessage = errorMessage
    this.persist()
    this.emitUpdate()
  }

  externalComplete(id: string, finalPath?: string): void {
    const item = this.get(id)
    if (!item) return
    item.state = 'completed'
    item.finishedAt = Date.now()
    item.progress.percent = 1
    item.progress.speed = 0
    item.progress.connections = 0
    if (finalPath) {
      item.savePath = finalPath
      item.name = basename(finalPath)
    }
    try {
      const size = statSync(item.savePath).size
      item.progress.totalBytes = size
      item.progress.downloadedBytes = size
    } catch {
      /* yoksay */
    }
    this.persist()
    this.emitUpdate()
    this.emit('completed', item)
  }

  externalError(id: string, message: string): void {
    const item = this.get(id)
    if (!item) return
    item.state = 'error'
    item.errorMessage = message
    item.progress.speed = 0
    item.progress.connections = 0
    this.persist()
    this.emitUpdate()
    this.emitError(item)
  }

  /** Yeni kayıt oluşturmadan mevcut kaydı güncelle (medya formatı seçimi vb.) */
  patchItem(id: string, patch: Partial<DownloadItem>): DownloadItem | undefined {
    const item = this.get(id)
    if (!item) return undefined
    Object.assign(item, patch)
    this.persist()
    this.emitUpdate()
    return item
  }

  /** Kuyruktaki slot kadar işi başlatır. */
  private schedulePump(): void {
    if (this.pumping) return
    this.pumping = true
    setImmediate(() => {
      this.pumping = false
      this.pump()
    })
  }

  private pump(): void {
    const settings = this.store.getSettings()
    const limit = Math.max(1, settings.general.maxConcurrent)
    const active = [...this.jobs.keys()]
    if (active.length >= limit) return

    const candidates = this.items
      .filter((i) => i.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)

    for (const item of candidates) {
      if (this.jobs.size >= limit) break
      void this.launch(item, settings.general.segmentsPerDownload, settings.general.speedLimitMbps)
    }
  }

  private async launch(item: DownloadItem, segments: number, speedLimitMbps: number): Promise<void> {
    if (this.jobs.has(item.id)) return

    // Dosya tamamlanmışsa kısa devre:
    // Boyut tek başına YETERLİ DEĞİL — dosya baştan truncate edildiği için
    // yarım dosya da tam boyutta görünür. İndirilen bayt da dolu olmalı.
    if (item.progress.totalBytes > 0 && item.progress.downloadedBytes >= item.progress.totalBytes) {
      try {
        const st = statSync(item.savePath)
        if (st.size === item.progress.totalBytes) {
          item.state = 'completed'
          item.progress.percent = 1
          item.progress.downloadedBytes = st.size
          item.progress.speed = 0
          this.persist()
          this.emitUpdate()
          this.schedulePump()
          return
        }
      } catch {
        /* dosya yok */
      }
    }

    item.state = 'downloading'
    item.startedAt = item.startedAt ?? Date.now()
    item.progress.speed = 0
    item.progress.connections = 0
    this.emitUpdate()

    // Sonradan Range bilgisi geldiyse ve toplam boyut yoksa çözümlenmemiş say
    let totalBytes = item.progress.totalBytes
    let supportsRange = this.getRangeSupport(item)
    if (!totalBytes) {
      const probe = await probeUrl(item.url, { pageUrl: item.pageUrl })
      if (this.get(item.id) !== item) return
      if (probe.ok) {
        totalBytes = probe.sizeBytes ?? 0
        supportsRange = probe.supportsRange
        item.progress.totalBytes = totalBytes
        this.rangeSupport.set(item.id, supportsRange)
        if (probe.name && (!item.name || item.name === 'download')) {
          item.name = probe.name
        }
        this.persist()
        this.emitUpdate()
      } else {
        item.state = 'error'
        item.errorMessage = probe.error
        this.emitError(item)
        this.schedulePump()
        return
      }
    }

    const snapshot = this.pausedSnapshots.get(item.id)
    this.pausedSnapshots.delete(item.id)

    const job = new SegmentedJob(
      {
        url: item.url,
        savePath: item.savePath,
        totalBytes,
        supportsRange,
        segments: Math.max(1, segments),
        pageUrl: item.pageUrl,
        speedLimitBps: speedLimitMbps > 0 ? speedLimitMbps * 1024 * 1024 : 0
      },
      {
        onProgress: ({ downloadedBytes, totalBytes: tb, speed, connections }) => {
          if (this.get(item.id) !== item) return
          this.applyProgress(item, downloadedBytes, totalBytes || tb, speed, connections)
        },
        onDone: () => {
          if (this.get(item.id) !== item) return
          this.jobs.delete(item.id)
          this.onJobDone(item)
        },
        onError: (err) => {
          if (this.get(item.id) !== item) return
          this.jobs.delete(item.id)
          // Duraklatma mı yoksa hata mı?
          if (item.state === 'downloading') {
            item.state = 'error'
            item.errorMessage = err.message
            item.progress.speed = 0
            item.progress.connections = 0
            this.persist()
            this.emitUpdate()
            this.emitError(item)
          }
          this.schedulePump()
        }
      }
    )

    this.jobs.set(item.id, job)
    try {
      await job.start(snapshot)
    } catch (e: any) {
      this.jobs.delete(item.id)
      item.state = 'error'
      item.errorMessage = e?.message || t('err.generic')
      item.progress.speed = 0
      this.persist()
      this.emitUpdate()
      this.emitError(item)
      this.schedulePump()
    }
  }

  private progressThrottle = new Map<string, number>()

  private applyProgress(
    item: DownloadItem,
    downloaded: number,
    total: number,
    speed: number,
    connections: number
  ): void {
    item.progress.downloadedBytes = downloaded
    item.progress.totalBytes = total
    item.progress.speed = speed
    item.progress.connections = connections
    if (total > 0) {
      item.progress.percent = Math.min(1, downloaded / total)
      item.progress.etaSeconds = speed > 0 ? (total - downloaded) / speed : null
    } else {
      item.progress.percent = 0
      item.progress.etaSeconds = null
    }

    const now = Date.now()
    const last = this.progressThrottle.get(item.id) || 0
    if (now - last > 350) {
      this.progressThrottle.set(item.id, now)
      this.emit('progress', item)
    }
  }

  private onJobDone(item: DownloadItem): void {
    // Boyutsuz URL'lerde "bitti" sadece job'tan gelir
    item.state = 'completed'
    item.finishedAt = Date.now()
    item.progress.percent = 1
    item.progress.speed = 0
    item.progress.connections = 0
    if (item.progress.totalBytes === 0) {
      try {
        item.progress.totalBytes = statSync(item.savePath).size
        item.progress.downloadedBytes = item.progress.totalBytes
      } catch {
        /* yoksay */
      }
    }
    this.persist()
    this.emitUpdate()
    this.emit('completed', item)
    this.schedulePump()
  }

  private emitUpdate(): void {
    this.emit('downloads', this.items)
  }

  private emitError(item: DownloadItem): void {
    this.emit('download-error', item)
  }

  /** Kaldırılan dosyayı diske yaz (anlık kapanışlar için) */
  persistNow(): void {
    this.store.saveDownloadsNow(this.items)
  }

  private persist(): void {
    this.store.saveDownloads(this.items)
  }

  /** Devam eden iş sayısını döndür (test/günlük için) */
  activeCount(): number {
    return this.jobs.size
  }
}

function makeId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** varsa benzersiz yol üretir: dosya (1).ext, dosya (2).ext … */
export function uniquePath(p: string): string {
  if (!existsSync(p)) return p
  const dir = dirname(p)
  const base = basename(p)
  const ext = extname(p)
  const stem = base.slice(0, base.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${stem} (${Date.now()})${ext}`)
}

/** Zamanlanmış işler için saniyelik tik (index.ts tarafından çağrılır) */
export function startScheduler(manager: DownloadManager): () => void {
  const timer = setInterval(() => manager.checkSchedules(), 1000)
  return () => clearInterval(timer)
}
