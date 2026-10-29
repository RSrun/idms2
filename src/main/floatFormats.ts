import type {
  FloatFormat,
  FloatMediaInfo,
  MediaFormat
} from '@shared/types'

/**
 * Yüzen panelin kalite listesini üretir (IDM'nin yüzen panelindeki gibi).
 *
 * İki kaynak var:
 *  - Oynatıcının <source> listesi → doğrudan dosya adresleri (yt-dlp gerekmez)
 *  - yt-dlp biçim listesi → sosyal medya / HLS-DASH yayınları
 *
 * Bu modül saftır (Electron/yan etki yok); motor testleri doğrudan koşar.
 */

export interface FloatProbeResult {
  ok: boolean
  formats: FloatFormat[]
  /** Liste boşsa/hata varsa panelde gösterilecek kısa not */
  note?: string
}

export interface FloatFormatsOptions {
  /** ffmpeg var → "sadece ses (MP3)" seçeneği sunulur */
  audioExtract?: boolean
  maxVideo?: number
  maxAudio?: number
}

const STREAM_RE = /\.m3u8(\?|#|$)|\.mpd(\?|#|$)|\/manifest|format=m3u8/i

/** HLS/DASH yayın adresi mi (tek dosya gibi indirilemez)? */
export function isStreamAddress(url: string): boolean {
  return STREAM_RE.test(url)
}

/** Liste/akış sayfası olan ilk yol parçaları (tek bir video değil). */
const GENERIC_SEGMENTS = new Set([
  'explore',
  'search',
  'results',
  'feed',
  'home',
  'trending',
  'discover',
  'foryou',
  'tag',
  'tags',
  'hashtag',
  'reels',
  'stories',
  'notifications',
  'inbox',
  'profile',
  'settings'
])

/** `/reels/` altında gönderi kimliği olmayan alt yollar (ses/hikâye listeleri). */
const NOT_ITEM_SEGMENTS = new Set(['audio', 'highlights', 'saved', 'liked'])

/**
 * Liste kökü gibi görünen ama aslında tek bir gönderi olan yol
 * (Instagram'da bir reel açılınca adres `/reels/{kod}/` olur).
 */
function isSingleItemPath(segments: string[]): boolean {
  if (segments[0] !== 'reels') return false
  const id = segments[1] || ''
  return /^[a-z0-9_-]{5,}$/.test(id) && !NOT_ITEM_SEGMENTS.has(id)
}

/**
 * Adres tek bir video/gönderi mi? Ana sayfa, keşfet, profil, akış gibi
 * listeleme sayfalarını yt-dlp çözemez ("Unsupported URL"); bu durumda ham
 * hata yerine kullanıcıya kısa bir yönlendirme gösterilir.
 */
export function isGenericPage(url: string | null | undefined): boolean {
  if (!url) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!/^https?:$/.test(parsed.protocol)) return false
  // Video kimliği sorguda olabilir: youtube.com/watch?v=…, facebook.com/watch/?v=…
  for (const key of ['v', 'list', 'video_id', 'story_fbid']) {
    if (parsed.searchParams.get(key)) return false
  }
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase())
  if (segments.length === 0) return true
  // `/reels/` bir liste sayfasıdır, `/reels/{kod}/` ise tek bir reel.
  if (isSingleItemPath(segments)) return false

  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
  // Reddit'te /r/{alt}/ ve /user/{ad}/ liste sayfasıdır; tek gönderide
  // adreste /comments/ bulunur.
  if (/(^|\.)reddit\.com$/i.test(host) && !segments.includes('comments')) {
    if (segments[0] === 'r' || segments[0] === 'user' || segments[0] === 'u') return true
  }
  // Instagram'da tek parçalı yol bir profildir (gönderi yolları yukarıda elendi).
  if (/(^|\.)instagram\.com$/i.test(host) && segments.length === 1) return true

  return GENERIC_SEGMENTS.has(segments[0])
}

export type ProbeErrorKind = 'login' | 'unsupported' | 'unavailable'

/**
 * yt-dlp hata metnini panelde gösterilebilecek kısa bir türe indirger.
 * Ham "ERROR: …" metni kullanıcıya gösterilmez.
 */
export function classifyProbeError(raw: string | null | undefined): ProbeErrorKind | null {
  const text = String(raw || '').trim()
  if (!text) return null
  if (/unsupported url|is not a valid url/i.test(text)) return 'unsupported'
  if (
    /log ?in|login required|sign in|cookie|authenticat|private|members[- ]only|age.?restrict|rate.?limit|too many requests|\b429\b|consent/i.test(
      text
    )
  ) {
    return 'login'
  }
  if (
    /not available|unavailable|no video|no formats|does not exist|removed|not found|\b404\b|\b410\b|no media/i.test(
      text
    )
  ) {
    return 'unavailable'
  }
  return null
}

/** "1920x1080" / "1080p" / "1920×1080" → 1080 */
export function heightOf(resolution: string | null | undefined): number | null {
  if (!resolution) return null
  const m = /(\d{3,4})\s*[x×]\s*(\d{3,4})/.exec(resolution)
  if (m) return Math.min(parseInt(m[1], 10), parseInt(m[2], 10))
  const p = /^(\d{3,4})p?$/i.exec(resolution.trim())
  if (p) return parseInt(p[1], 10)
  return null
}

/**
 * Ekstraktör sitelerinde (Reddit, YouTube, Instagram…) oynatıcının `<source>`
 * listesi çoğu zaman tek bir kopyadır — Reddit'in doğrudan mp4'ü gibi. Tam
 * kalite listesi (ve ayrı ses dosyaları) için önce yt-dlp denenmelidir.
 *
 * Dönen değer yt-dlp'ye verilecek sayfa adresidir; bu sayfa tek bir video
 * değilse (akış/profil) ya da site ekstraktör değilse `null`.
 */
export function probeFirstTarget(
  media: Pick<FloatMediaInfo, 'needsExtractor' | 'pageUrl' | 'url'>
): string | null {
  if (!media.needsExtractor) return null
  const target = media.pageUrl || media.url || ''
  if (!/^https?:\/\//i.test(target)) return null
  if (isGenericPage(target)) return null
  return target
}

function score(f: MediaFormat): number {
  return f.tbr || 0 || (f.sizeBytes ? f.sizeBytes / 1024 : 0)
}

/**
 * Aynı kalite grubunda hangi biçim daha iyi?
 * HLS (m3u8) akışları ayrı ses akışıyla birleştirilemediği için DASH
 * (https) kopyası varsa o seçilir; yoksa yüksek bit hızlı olan kazanır.
 */
function betterFormat(a: MediaFormat, b: MediaFormat): boolean {
  if (!!a.hls !== !!b.hls) return !a.hls
  return score(a) > score(b)
}

function videoDetail(f: MediaFormat): string {
  const bits: string[] = [f.ext.toUpperCase()]
  const res = f.resolution ? f.resolution.replace(/\s*[x×]\s*/i, '×') : ''
  if (res) bits.push(res)
  if (typeof f.fps === 'number' && f.fps > 0) bits.push(`${Math.round(f.fps)} fps`)
  return bits.join(' · ')
}

function audioDetail(f: MediaFormat): string {
  const bits: string[] = []
  if (f.tbr && f.tbr > 0) bits.push(`${Math.round(f.tbr)} kbps`)
  else if (f.sizeBytes) bits.push(`${Math.round(f.sizeBytes / 1024)} KB`)
  return bits.join(' · ')
}

/** yt-dlp biçim listesi → panelin kalite satırları. */
export function formatsFromProbe(
  formats: MediaFormat[],
  opts: FloatFormatsOptions = {}
): FloatFormat[] {
  const maxVideo = opts.maxVideo ?? 6
  const maxAudio = opts.maxAudio ?? 4

  // Aynı çözünürlükten tek satır: en yüksek bit hızlı olan
  const videos = new Map<string, { f: MediaFormat; height: number | null }>()
  const audios = new Map<string, MediaFormat>()

  for (const f of formats) {
    if (!f || !f.formatId) continue
    if (f.isAudioOnly) {
      if (!f.acodec) continue
      const key = (f.ext || 'audio').toLowerCase()
      const prev = audios.get(key)
      if (!prev || betterFormat(f, prev)) audios.set(key, f)
      continue
    }
    if (!f.vcodec) continue
    const height = heightOf(f.resolution)
    const key = height ? `h${height}` : (f.resolution || f.ext || 'v').toLowerCase()
    const prev = videos.get(key)
    if (!prev || betterFormat(f, prev.f)) videos.set(key, { f, height })
  }

  const videoRows: FloatFormat[] = [...videos.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || score(b.f) - score(a.f))
    .slice(0, maxVideo)
    .map((entry, i) => ({
      formatId: entry.f.formatId,
      kind: 'video',
      label: entry.height ? `${entry.height}p` : entry.f.resolution || entry.f.ext.toUpperCase(),
      detail: videoDetail(entry.f),
      sizeBytes: entry.f.sizeBytes ?? null,
      best: i === 0
    }))

  const audioRows: FloatFormat[] = [...audios.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, maxAudio)
    .map((f, i) => ({
      formatId: f.formatId,
      kind: 'audio',
      label: f.ext.toUpperCase(),
      detail: audioDetail(f),
      sizeBytes: f.sizeBytes ?? null,
      best: i === 0
    }))

  return [...videoRows, ...audioRows]
}

function extOf(url: string): string {
  try {
    const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(new URL(url).pathname + (new URL(url).search || ''))
    return m ? m[1].toUpperCase() : ''
  } catch {
    return ''
  }
}

function mimeExt(mime?: string): string {
  if (!mime) return ''
  if (/mpegurl/i.test(mime)) return 'HLS'
  if (/dash\+xml/i.test(mime)) return 'DASH'
  const m = /\/([a-z0-9.+-]+)/i.exec(mime)
  if (!m) return ''
  return m[1].split(/[.+-]/)[0].toUpperCase() || m[1].toUpperCase()
}

function looksAudioUrl(url: string, mime?: string): boolean {
  if (mime && /^audio\//i.test(mime)) return true
  return /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(url)
}

function looksAudio(media: FloatMediaInfo, url: string, mime?: string): boolean {
  if (media.kind === 'audio') return true
  return looksAudioUrl(url, mime)
}

const KNOWN_HEIGHTS = [2160, 1440, 1080, 900, 720, 480, 360, 240]

/** Oynatıcı etiketinden / adresten kalite etiketi çıkarır: "1080p", "720p"… */
export function qualityLabel(label: string | undefined, url: string, mime?: string): string {
  const raw = (label || '').trim()
  const fromLabel = /(\d{3,4})\s*[pP]\b/.exec(raw)
  if (fromLabel) return `${fromLabel[1]}p`
  const fromSize = /(\d{3,4})\s*[x×]\s*(\d{3,4})/.exec(raw)
  if (fromSize) return `${Math.min(parseInt(fromSize[1], 10), parseInt(fromSize[2], 10))}p`

  const fromUrl = /(\d{3,4})\s*[pP](?:[^\d]|$)/.exec(url)
  if (fromUrl) return `${fromUrl[1]}p`
  for (const h of KNOWN_HEIGHTS) {
    if (new RegExp(`[^\\d]${h}[^\\d]`).test(url)) return `${h}p`
  }

  if (raw && raw.length <= 16) return raw
  if (looksAudioUrl(url, mime)) return 'Ses'
  return 'Video'
}

function rankOf(label: string): number {
  const m = /(\d{3,4})p/.exec(label)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * Oynatıcının <source> listesi → kalite satırları.
 * Kaynak yoksa özgün dosya tek satır olarak gösterilir.
 */
export function formatsFromSources(
  media: FloatMediaInfo,
  opts: FloatFormatsOptions = {}
): FloatFormat[] {
  const maxVideo = opts.maxVideo ?? 6
  const rows: FloatFormat[] = []
  const seen = new Set<string>()

  const sources = (media.sources || []).filter((s) => s && /^https?:\/\//i.test(s.url || ''))
  let index = 0
  for (const s of sources) {
    const key = s.url.split('#')[0]
    if (seen.has(key)) continue
    seen.add(key)
    const kind: 'video' | 'audio' = looksAudio(media, s.url, s.mime) ? 'audio' : 'video'
    const label = qualityLabel(s.label, s.url, s.mime)
    const detail = [
      mimeExt(s.mime) || extOf(s.url),
      s.label && s.label.length <= 20 && s.label !== label ? s.label : ''
    ]
      .filter(Boolean)
      .join(' · ')
    rows.push({
      formatId: `src:${index++}`,
      kind,
      label,
      detail: detail || undefined,
      url: s.url,
      best: false
    })
  }

  const videoRows = rows
    .filter((r) => r.kind === 'video')
    .sort((a, b) => rankOf(b.label) - rankOf(a.label))
    .slice(0, maxVideo)
  const audioRows = rows.filter((r) => r.kind === 'audio')

  if (videoRows.length === 0 && media.kind === 'video') {
    videoRows.push({
      formatId: 'direct',
      kind: 'video',
      label: 'Video',
      labelKey: 'origVideo',
      detail: extOf(media.url) || undefined,
      url: /^https?:\/\//i.test(media.url) ? media.url : undefined,
      best: true
    })
  } else if (videoRows.length > 0) {
    videoRows[0].best = true
  }

  if (media.kind === 'audio' && audioRows.length === 0) {
    audioRows.push({
      formatId: 'direct',
      kind: 'audio',
      label: extOf(media.url) || 'Ses',
      labelKey: 'origAudio',
      url: /^https?:\/\//i.test(media.url) ? media.url : undefined,
      best: true
    })
  } else if (audioRows.length > 0) {
    audioRows[0].best = true
  }

  // Sadece ses (MP3) — yalnızca ffmpeg varsa anlamlı
  if (opts.audioExtract && media.kind !== 'audio') {
    audioRows.push({
      formatId: 'audio:mp3',
      kind: 'audio',
      label: 'MP3',
      labelKey: 'audioMp3',
      best: audioRows.length === 0
    })
  }

  return [...videoRows, ...audioRows].slice(0, 10)
}
