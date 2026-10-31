import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import { createWriteStream, promises as fsp } from 'fs'
import { dirname } from 'path'
import type { FileHandle } from 'fs/promises'
import { buildDownloadHeaders } from './probe'

export interface SegmentState {
  index: number
  start: number
  end: number
  /** bu segmentte indirilen bayt */
  received: number
}

export interface JobOptions {
  url: string
  savePath: string
  totalBytes: number
  supportsRange: boolean
  segments: number
  pageUrl?: string
  headers?: Record<string, string>
  /** 0 = sınırsız, bayt/sn */
  speedLimitBps?: number
}

export interface JobEvents {
  onProgress: (info: {
    downloadedBytes: number
    totalBytes: number
    speed: number
    connections: number
  }) => void
  onDone: () => void
  onError: (err: Error) => void
}

const MAX_RETRIES = 5
const RETRY_DELAY_MS = 800
const CONNECT_TIMEOUT_MS = 20000
const IDLE_TIMEOUT_MS = 30000
/** Hız ölçüm penceresi (ms) */
const SPEED_WINDOW_MS = 1000

class SpeedMeter {
  private samples: Array<{ at: number; bytes: number }> = []
  private totalSampled = 0

  add(bytes: number): void {
    const now = Date.now()
    this.samples.push({ at: now, bytes })
    this.totalSampled += bytes
    this.prune(now)
  }

  private prune(now: number): void {
    const cutoff = now - SPEED_WINDOW_MS * 2
    while (this.samples.length > 1 && this.samples[0].at < cutoff) {
      this.totalSampled -= this.samples.shift()!.bytes
    }
  }

  get speed(): number {
    const now = Date.now()
    this.prune(now)
    if (this.samples.length === 0) return 0
    const first = this.samples[0]
    const span = Math.max(now - first.at, 200)
    return Math.round((this.totalSampled / span) * 1000)
  }
}

/**
 * Çok segmentli HTTP indirme işi.
 *
 * - Dosya tek bir fd'ye segment ofsetlerine eşzamanlı yazılır.
 * - Range destekleyen sunucularda N paralel bağlantı açılır.
 * - Desteklemeyen sunucularda tek bağlantı fallback'i vardır.
 * - Her segment kendi yeniden deneme döngüsüne sahiptir (IDM'deki gibi).
 * - Duraklat/kaldır için AbortController + fd close kullanılır.
 */
export class SegmentedJob {
  private opts: JobOptions
  private events: JobEvents
  private fd: FileHandle | null = null
  private segments: SegmentState[] = []
  private abort = new AbortController()
  private meter = new SpeedMeter()
  private downloaded = 0
  private activeRequests = 0
  private finished = false
  private errored = false
  private lastActivity = Date.now()
  private speedLimiter: { last: number; tokens: number } | null = null
  private progressTimer: ReturnType<typeof setInterval> | null = null
  private throttleTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: JobOptions, events: JobEvents) {
    this.opts = opts
    this.events = events
    if (opts.speedLimitBps && opts.speedLimitBps > 0) {
      // Kova sıfırdan başlar: ilk saniyede tam limit kadar patlama olmaz
      this.speedLimiter = { last: Date.now(), tokens: 0 }
    }
  }

  get isFinished(): boolean {
    return this.finished
  }

  get bytesDownloaded(): number {
    return this.downloaded
  }

  /**
   * Kuyruktan gelen mevcut segment ilerlemesiyle devam eder
   * (resume için); yoksa sıfırdan planlar.
   */
  async start(existing?: SegmentState[]): Promise<void> {
    const { savePath, totalBytes, supportsRange, segments } = this.opts
    try {
      await fsp.mkdir(dirname(savePath), { recursive: true })
    } catch {
      /* yoksay */
    }

    if (supportsRange && totalBytes > 0 && segments > 1) {
      this.segments = existing && existing.length ? existing : this.planSegments(totalBytes, segments)
      // fd'yi her zaman r+ (varsa) / w+ ile aç; boyutu önceden ayarla
      this.fd = await fsp.open(savePath, 'r+').catch(async () => {
        const fh = await fsp.open(savePath, 'w+')
        return fh
      })
      await this.fd.truncate(totalBytes).catch(() => undefined)
    } else {
      // Tek bağlantı: dosya boyutu bilinmeyebilir
      this.segments = [
        {
          index: 0,
          start: existing?.[0]?.received ?? 0,
          end: totalBytes > 0 ? totalBytes - 1 : Number.MAX_SAFE_INTEGER,
          received: existing?.[0]?.received ?? 0
        }
      ]
      this.fd = await fsp.open(savePath, existing?.[0]?.received ? 'r+' : 'w+')
      if (existing?.[0]?.received) {
        await this.fd.truncate(existing[0].received).catch(() => undefined)
      }
    }

    this.downloaded = this.segments.reduce((a, s) => a + s.received, 0)
    this.lastActivity = Date.now()

    this.progressTimer = setInterval(() => {
      // Güven ağı: bir tetikleme kaçtıysa tamamlamayı burada yakala
      this.maybeDone()
      this.emitProgress()
    }, 400)
    if (this.speedLimiter) {
      this.throttleTimer = setInterval(() => this.refillTokens(), 200)
    }

    // Segmentleri başlat (eşzamanlılık zaten opts.segments ile sınırlı)
    for (const seg of this.segments) {
      if (seg.received + seg.start > seg.end && seg.end !== Number.MAX_SAFE_INTEGER) continue
      this.runSegment(seg)
    }
    // Tüm segmentler zaten doluysa (resume kenarı) tetikleyici gerekir
    this.maybeDone()

    // idle watchdog
    const watchdog = setInterval(() => {
      if (this.finished) {
        clearInterval(watchdog)
        return
      }
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS && this.activeRequests > 0) {
        this.killActive(new Error('bağlantı zaman aşımına uğradı (boşta)'))
      }
    }, 5000)
    this.abort.signal.addEventListener('abort', () => clearInterval(watchdog))
  }

  private planSegments(totalBytes: number, count: number): SegmentState[] {
    const n = Math.max(1, Math.min(count, Math.floor(totalBytes / (256 * 1024)) || 1))
    const size = Math.floor(totalBytes / n)
    const segs: SegmentState[] = []
    for (let i = 0; i < n; i++) {
      const start = i * size
      const end = i === n - 1 ? totalBytes - 1 : start + size - 1
      segs.push({ index: i, start, end, received: 0 })
    }
    return segs
  }

  /** Duraklatma anındaki segment durumunu döndür (kaydetmek için) */
  snapshot(): SegmentState[] {
    return this.segments.map((s) => ({ ...s }))
  }

  private refillTokens(): void {
    if (!this.speedLimiter) return
    const limit = this.opts.speedLimitBps!
    const now = Date.now()
    const elapsed = (now - this.speedLimiter.last) / 1000
    this.speedLimiter.last = now
    this.speedLimiter.tokens = Math.min(limit, this.speedLimiter.tokens + limit * elapsed)
  }

  /** Hız sınırı: token yoksa beklet, varsa harca */
  private async consumeTokens(bytes: number): Promise<void> {
    if (!this.speedLimiter) return
    // Çok büyük parçaları sınıra böl
    const limit = this.opts.speedLimitBps!
    const chunk = Math.min(bytes, Math.max(Math.floor(limit / 4), 16 * 1024))
    while (this.speedLimiter.tokens < chunk && !this.abort.signal.aborted) {
      const need = chunk - this.speedLimiter.tokens
      const waitMs = Math.ceil((need / limit) * 1000)
      await sleep(Math.min(Math.max(waitMs, 50), 500))
      this.refillTokens()
      this.speedLimiter.tokens = Math.min(limit, this.speedLimiter.tokens)
      if (this.speedLimiter.tokens >= chunk) break
    }
    if (!this.abort.signal.aborted && this.speedLimiter) {
      this.speedLimiter.tokens -= chunk
    }
  }

  private emitProgress(): void {
    if (this.finished) return
    this.events.onProgress({
      downloadedBytes: this.downloaded,
      totalBytes: this.opts.totalBytes,
      speed: this.meter.speed,
      connections: this.activeRequests
    })
  }

  private async runSegment(seg: SegmentState, attempt = 0): Promise<void> {
    if (this.abort.signal.aborted || this.finished || this.errored) return

    const complete = seg.end !== Number.MAX_SAFE_INTEGER && seg.start + seg.received > seg.end
    if (complete) {
      this.maybeDone()
      return
    }

    this.activeRequests++
    try {
      await this.fetchSegment(seg)
    } catch (e: any) {
      if (this.abort.signal.aborted || this.finished) return
      if (e?.code === 'ABORT_ERR' || e?.name === 'AbortError') return
      if (attempt < MAX_RETRIES && !this.errored) {
        await sleep(RETRY_DELAY_MS * Math.pow(1.6, attempt))
        // activeRequests'ı finally düşürür; tekrar düşürme
        return this.runSegment(seg, attempt + 1)
      }
      this.fail(e instanceof Error ? e : new Error(String(e)))
      return
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
    this.maybeDone()
  }

  private fetchSegment(seg: SegmentState): Promise<void> {
    return new Promise((resolve, reject) => {
      const { url, pageUrl, headers: extraHeaders, totalBytes } = this.opts
      const parsed = new URL(url)
      const isHttps = parsed.protocol === 'https:'

      const headers = buildDownloadHeaders(pageUrl, extraHeaders)
      const rangeStart = seg.start + seg.received
      if (this.opts.supportsRange && totalBytes > 0) {
        headers.Range = `bytes=${rangeStart}-${seg.end}`
      } else if (seg.received > 0) {
        // Range'siz devam: varsayım — desteklemiyorsa sıfırdan başla
        headers.Range = `bytes=${rangeStart}-`
      }

      let settled = false
      let doneRequested = false
      let requestedErr: Error | undefined
      /**
       * Parçalar bu segmentte SIRAYLA işlenir. seg.received böylece her
       * zaman ardışık bir önek kalır — duraklat snapshot'ı ancak bu şekilde
       * doğru devam aralığını verir (resume'da boşluk kalmaz).
       */
      let chain: Promise<void> = Promise.resolve()
      /** Yazım hatası oldu: bu denemede sonraki parçaları atla */
      let segFailed = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined

      const settleNow = (err?: Error) => {
        cleanup()
        if (err) reject(err)
        else resolve()
      }

      const maybeSettle = () => {
        if (settled || !doneRequested) return
        settled = true
        settleNow(requestedErr)
      }

      /**
       * Bitir; ama sıradaki/kuyruktaki yazımlar diske DÖKÜLMEDEN dönme.
       * Aksi halde maybeDone() "received" güncellenmeden çalışır ve indirme
       * asla tamamlanmış sayılmaz.
       */
      const done = (err?: Error) => {
        if (err && !settled) requestedErr = err // hata her zaman öncelikli
        if (doneRequested || settled) return
        doneRequested = true
        chain.then(maybeSettle, maybeSettle)
      }

      const req = (isHttps ? httpsRequest : httpRequest)(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers,
          signal: this.abort.signal
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume()
            const next = new URL(res.headers.location, url).toString()
            this.opts.url = next
            cleanup()
            // Yönlendirmeyi bu sözle bitir; hata bubbled olur
            this.fetchSegment(seg).then(() => done(), (e) => done(e))
            return
          }

          if (res.statusCode === 416) {
            // Aralık talebi kabul edilmedi: dosya tamamlanmış say
            res.resume()
            seg.received = Math.max(seg.received, seg.end - seg.start + 1)
            done()
            return
          }
          if (res.statusCode && res.statusCode >= 400) {
            res.resume()
            const map: Record<number, string> = {
              403: 'erişim reddedildi (403)',
              404: 'dosya bulunamadı (404)',
              410: 'dosya artık yok (410)'
            }
            done(new Error(map[res.statusCode] || `sunucu hatası (${res.statusCode})`))
            return
          }

          res.on('data', (chunk: Buffer) => {
            if (this.abort.signal.aborted) {
              res.destroy()
              return
            }
            this.lastActivity = Date.now()
            // Akışı durdur: kuyruğun sınırlı kalsın (geri basınç) +
            // parçalar fiilen sırayla işlensin
            res.pause()
            chain = chain.then(async () => {
              try {
                if (this.abort.signal.aborted || segFailed) return

                // Segmentin kalan payı = seg.received'dan türetilir (tek doğru kaynak)
                const pos = seg.start + seg.received
                const remain =
                  seg.end !== Number.MAX_SAFE_INTEGER ? seg.end - pos + 1 : Infinity
                const buf =
                  chunk.length > remain ? chunk.subarray(0, Math.max(0, remain)) : chunk
                if (buf.length === 0) return

                if (this.speedLimiter) await this.consumeTokens(buf.length)
                if (this.abort.signal.aborted || !this.fd) return

                await this.fd.write(buf, 0, buf.length, pos)
                // Yalnızca yazım başarılıysa say: snapshot = ardışık önek
                seg.received += buf.length
                this.downloaded += buf.length
                this.meter.add(buf.length)

                if (seg.end !== Number.MAX_SAFE_INTEGER && seg.start + seg.received > seg.end) {
                  // Segment doldu
                  res.destroy()
                  done()
                }
              } catch (e) {
                segFailed = true
                res.destroy()
                done(e instanceof Error ? e : new Error(String(e)))
              } finally {
                if (!res.destroyed) res.resume()
              }
            })
          })

          res.on('end', () => done())
          res.on('close', () => {
            if (settled || doneRequested) return
            if (this.abort.signal.aborted) {
              done()
              return
            }
            // Sunucu erken kapattıysa segment eksik kalmış olabilir
            if (
              (seg.end !== Number.MAX_SAFE_INTEGER && seg.start + seg.received > seg.end) ||
              segFailed
            ) {
              done()
            } else {
              done(new Error('bağlantı beklenmedik şekilde kapandı'))
            }
          })
          res.on('error', (e) => done(e))
        }
      )

      const cleanup = () => {
        req.removeAllListeners()
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }

      req.on('timeout', () => req.destroy(new Error('bağlantı zaman aşımı')))
      req.on('error', (e) => done(e))
      // Bağlantı hatalarında CONNECT_TIMEOUT uygula
      timeoutHandle = setTimeout(() => {
        if (!settled && this.activeRequests > 0 && Date.now() - this.lastActivity > CONNECT_TIMEOUT_MS) {
          req.destroy(new Error('bağlantı zaman aşımı'))
        }
      }, CONNECT_TIMEOUT_MS)
      req.on('close', () => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      })

      req.end()
    })
  }

  private killActive(err: Error): void {
    this.fail(err)
  }

  private maybeDone(): void {
    if (this.finished || this.errored) return
    if (this.activeRequests > 0) return
    const allDone = this.segments.every((s) =>
      s.end === Number.MAX_SAFE_INTEGER
        ? false // bilinmeyen boyut: end gelmeden asla "bitti" deme
        : s.start + s.received > s.end
    )
    if (allDone) {
      this.finish()
    }
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.cleanup()
    this.emitProgress()
    this.events.onDone()
  }

  private fail(err: Error): void {
    if (this.errored || this.finished) return
    this.errored = true
    this.cleanup()
    this.events.onError(err)
  }

  /** Kullanıcı duraklattı: istekleri durdur ve fd'yi kapat */
  pause(): SegmentState[] {
    const snap = this.snapshot()
    this.abort.abort()
    this.cleanup()
    this.finished = true
    return snap
  }

  cancel(): void {
    this.abort.abort()
    this.cleanup()
    this.finished = true
  }

  private cleanup(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
    }
    if (this.throttleTimer) {
      clearInterval(this.throttleTimer)
      this.throttleTimer = null
    }
    // fd'yi kapat (yazma işleri kalsın diye kısa gecikme ile)
    setTimeout(async () => {
      try {
        await this.fd?.close()
      } catch {
        /* yoksay */
      }
      this.fd = null
    }, 150)
  }
}

/** Tek bağlantılı tam dosya indirme (bilinmeyen boyutlu URL'ler için). */
export async function downloadWholeFile(
  url: string,
  savePath: string,
  opts: { pageUrl?: string; onProgress?: (bytes: number) => void; signal?: AbortSignal } = {}
): Promise<void> {
  await fsp.mkdir(dirname(savePath), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const parsed = new URL(url)
    const req = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: buildDownloadHeaders(opts.pageUrl),
        signal: opts.signal
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          downloadWholeFile(next, savePath, opts).then(resolve, reject)
          return
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume()
          reject(new Error(`sunucu hatası (${res.statusCode})`))
          return
        }
        const ws = createWriteStream(savePath)
        let bytes = 0
        res.on('data', (c: Buffer) => {
          bytes += c.length
          opts.onProgress?.(bytes)
        })
        res.pipe(ws)
        ws.on('finish', () => resolve())
        ws.on('error', reject)
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
