import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import type { UrlProbeResult } from '@shared/types'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface ProbeOptions {
  pageUrl?: string
  method?: 'HEAD' | 'GET'
  timeoutMs?: number
}

function doRequest(
  urlStr: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; headers: Record<string, any>; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr) // geçersiz URL → executor reddeder
    const isHttps = parsed.protocol === 'https:'
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: timeoutMs
      },
      (res) => {
        // Yönlendirmeleri takip et
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()
          const next = new URL(res.headers.location, urlStr).toString()
          doRequest(next, method, headers, timeoutMs).then(resolve, reject)
          return
        }
        // Gövdeyi boşalt (HEAD'te gövde olmaz, GET'te ilk paketten sonra bırak)
        let truncated = false
        res.on('data', () => {
          truncated = true
          res.destroy()
        })
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, headers: res.headers as any, truncated })
        })
        res.on('close', () => {
          resolve({ status: res.statusCode || 0, headers: res.headers as any, truncated })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Content-Disposition'ten dosya adı çıkar */
export function filenameFromDisposition(cd: string | undefined): string | null {
  if (!cd) return null
  // filename*=UTF-8''...
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(cd)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* yoksay */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd)
  if (plain) return plain[1].trim()
  return null
}

/** URL'den makul dosya adı türet */
export function filenameFromUrl(urlStr: string): string {
  try {
    const p = new URL(urlStr)
    const base = p.pathname.split('/').filter(Boolean).pop()
    if (base) {
      const decoded = decodeURIComponent(base)
      if (decoded && decoded.includes('.')) return sanitizeFilename(decoded)
    }
  } catch {
    /* yoksay */
  }
  return 'download'
}

export function sanitizeFilename(name: string): string {
  // Windows'ta geçersiz karakterler
  let n = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  // Yedekleme uzantıları (con, prn vs.) ve nokta/boşluk sonu
  n = n.replace(/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i, '_$2')
  n = n.replace(/[. ]+$/, '')
  if (!n) n = 'download'
  if (n.length > 200) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : ''
    n = n.slice(0, 200 - ext.length) + ext
  }
  return n
}

/**
 * URL hakkında bilgi toplar: dosya adı, boyut, Range desteği, içerik türü.
 * HEAD dener; desteklenmezse GET ile dener.
 */
export async function probeUrl(urlStr: string, opts: ProbeOptions = {}): Promise<UrlProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const base: UrlProbeResult = {
    ok: false,
    url: urlStr,
    name: filenameFromUrl(urlStr),
    sizeBytes: null,
    supportsRange: false,
    contentType: null,
    host: ''
  }
  try {
    const parsed = new URL(urlStr)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ...base, error: `desteklenmeyen protokol: ${parsed.protocol}` }
    }
    base.host = parsed.hostname
  } catch {
    return { ...base, error: 'geçersiz URL' }
  }

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: '*/*'
  }
  if (opts.pageUrl) {
    headers.Referer = opts.pageUrl
  }

  let method: 'HEAD' | 'GET' = opts.method ?? 'HEAD'
  let res: Awaited<ReturnType<typeof doRequest>>
  try {
    res = await doRequest(urlStr, method, headers, timeoutMs)
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      // HEAD reddedildi: GET dene
      method = 'GET'
      res = await doRequest(urlStr, method, { ...headers, Range: 'bytes=0-0' }, timeoutMs)
    }
  } catch (e: any) {
    return { ...base, error: e?.message || 'bağlantı hatası' }
  }

  if (res.status >= 400) {
    const errText =
      res.status === 404 ? 'dosya bulunamadı (404)' : `sunucu hatası (${res.status})`
    return { ...base, error: errText }
  }

  const h = res.headers
  base.contentType = (h['content-type'] as string) || null

  const cdName = filenameFromDisposition(h['content-disposition'] as string)
  if (cdName) base.name = sanitizeFilename(cdName)

  const len = h['content-length'] ? parseInt(h['content-length'], 10) : NaN
  if (isFinite(len)) base.sizeBytes = len

  // content-range: bytes 0-0/12345 → toplam boyut
  const cr = h['content-range'] as string | undefined
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) base.sizeBytes = parseInt(m[1], 10)
    base.supportsRange = true
  }
  if ((h['accept-ranges'] as string | undefined)?.toLowerCase().includes('bytes')) {
    base.supportsRange = true
  }

  base.ok = true
  return base
}

/** İndirme için ortak istek başlıkları */
export function buildDownloadHeaders(pageUrl?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
  }
  if (pageUrl) headers.Referer = pageUrl
  if (extra) Object.assign(headers, extra)
  return headers
}

export const USER_AGENT = UA
