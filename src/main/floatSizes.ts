import { probeUrl } from './engine/probe'
import { isStreamAddress } from './floatFormats'
import type { FloatFormat } from '@shared/types'

/**
 * Kalite/ses satırlarına dosya boyutu ekler.
 *
 * yt-dlp biçimleri boyutu kendisi bildirir; oynatıcının `<source>` listesinde
 * ise yalnızca adres vardır. Burada her adrese kısa bir HEAD (gerekirse
 * Range: bytes=0-0) isteği atılır ve `Content-Length` okunur.
 *
 * - HLS/DASH yayınları atlanır (tek dosya boyutu yok).
 * - Toplam süre `budgetMs` ile sınırlıdır: yavaş sunucu paneli bekletmez,
 *   o satır yalnızca boyutsuz görünür.
 */

export interface FillSizesOptions {
  /** Referer olarak gönderilecek sayfa adresi */
  pageUrl?: string
  /** Tek istek için zaman aşımı */
  timeoutMs?: number
  /** Tüm boyut sorguları için toplam bütçe */
  budgetMs?: number
  /** Aynı anda açık istek sayısı */
  concurrency?: number
}

export async function fillFormatSizes(
  rows: FloatFormat[],
  opts: FillSizesOptions = {}
): Promise<FloatFormat[]> {
  const timeoutMs = opts.timeoutMs ?? 2500
  const budgetMs = opts.budgetMs ?? 4500
  const concurrency = Math.max(1, opts.concurrency ?? 3)

  const targets = rows.filter(
    (r) =>
      !!r.url &&
      !isStreamAddress(r.url) &&
      !(typeof r.sizeBytes === 'number' && r.sizeBytes > 0)
  )
  if (targets.length === 0) return rows

  const deadline = Date.now() + budgetMs
  const queue = [...targets]

  const worker = async (): Promise<void> => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const left = deadline - Date.now()
      if (left <= 0) return
      try {
        const probe = await probeUrl(row.url as string, {
          pageUrl: opts.pageUrl,
          timeoutMs: Math.min(timeoutMs, left)
        })
        if (probe.ok && typeof probe.sizeBytes === 'number' && probe.sizeBytes > 0) {
          row.sizeBytes = probe.sizeBytes
        }
      } catch {
        /* boyut bilinmiyorsa satır boyutsuz kalır */
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
  )
  return rows
}
