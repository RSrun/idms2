import { spawn, execFile, execSync } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, promises as fsp } from 'fs'
import { join, delimiter } from 'path'
import { homedir } from 'os'
import type { MediaFormat, MediaProbeResult, Settings } from '@shared/types'
import { probeUrl } from './engine/probe'

/**
 * yt-dlp (ve ffmpeg) ile sosyal medya indirme alt sistemi.
 *
 * - YouTube, Instagram, Facebook, Reddit, TikTok, X/Twitter, Vimeo… (yt-dlp'in 1000+ sitesi)
 * - `--dump-json` ile format listesi çıkarılır (indirmeden önce seçim ekranı)
 * - Çerez aktarımı: `--cookies` ile geçici Netscape çerez dosyası
 * - İlerleme: `--newline` çıktısı satır satır ayrılır
 */

/**
 * Çerez dosyası verilmediğinde yt-dlp'nin çerezleri doğrudan tarayıcıdan
 * alması için kullanılacak tarayıcı. Windows'ta Edge yaygın olduğu için ilk
 * sırada denenir; profil klasörüne göre Chrome/Brave/Firefox'a düşülür.
 */
function cookiesBrowser(): string | undefined {
  const home = homedir()
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  // Tarayıcı açıkken çerez veritabanı kilitlidir; yt-dlp kopyalayamaz
  // ("Could not copy Chrome cookie database"). Bu durumda tarayıcıdan çerez
  // almayı denemeyiz; eklenti zaten sayfa çerezlerini ayrıca gönderir.
  const open = (userData: string): boolean => existsSync(join(userData, 'lockfile'))
  if (process.platform === 'win32') {
    const edge = join(local, 'Microsoft', 'Edge', 'User Data')
    if (existsSync(edge)) return open(edge) ? undefined : 'edge'
    const chrome = join(local, 'Google', 'Chrome', 'User Data')
    if (existsSync(chrome)) return open(chrome) ? undefined : 'chrome'
    const brave = join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')
    if (existsSync(brave)) return open(brave) ? undefined : 'brave'
    if (existsSync(join(local, 'Mozilla', 'Firefox', 'Profiles'))) return 'firefox'
  } else if (process.platform === 'darwin') {
    if (existsSync(join(home, 'Library', 'Application Support', 'Microsoft Edge'))) return 'edge'
    if (existsSync(join(home, 'Library', 'Application Support', 'Google', 'Chrome'))) return 'chrome'
    if (existsSync(join(home, 'Library', 'Application Support', 'Firefox'))) return 'firefox'
  } else {
    if (existsSync(join(home, '.config', 'microsoft-edge'))) return 'edge'
    if (existsSync(join(home, '.config', 'google-chrome'))) return 'chrome'
    if (existsSync(join(home, '.mozilla', 'firefox'))) return 'firefox'
  }
  return undefined
}

export interface YtdlpProgress {
  percent: number
  speed: number
  etaSeconds: number | null
  statusLine: string
  /** yt-dlp çıktısındaki akış boyutu (bilinmiyorsa null) */
  totalBytes?: number | null
}

export interface YtdlpOptions {
  url: string
  saveDir: string
  formatId?: string
  quality?: 'best' | 'audio'
  pageUrl?: string
  cookies?: import('@shared/types').CookieRecord[]
  ffmpegPath?: string
  ytdlpPath?: string
  filenameTemplate?: string
  /** Var olan parça dosyalarını yok sayıp baştan indir (hatalı denemeden sonra) */
  forceOverwrite?: boolean
}

export interface RunOptions {
  args: string[]
  onLine?: (line: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

const BASE_ARGS = [
  '--no-warnings',
  '--no-playlist',
  '--newline',
  '--progress',
  // Windows'ta yt-dlp boruya sistem kod sayfasıyla (ör. cp1254) yazıyor;
  // UTF-8 zorlanmazsa Türkçe dosya adları bozulur ve yol eşleşmez.
  '--encoding',
  'utf-8'
]

/**
 * yt-dlp çıktısındaki olası ürün yolları. Birleştirme (`Merger`) ve ses
 * çıkarma (`ExtractAudio`) satırları, indirilen parçaların yerine geçer;
 * parçalar işlem sonunda silinir.
 */
const OUTPUT_PATH_PATTERNS = [
  /\[Merger\] Merging formats into "(.+)"\s*$/,
  /\[ExtractAudio\] Destination:\s*(.+)$/,
  /\[ffmpeg\] Destination:\s*(.+)$/,
  /\[FixupM3u8\] Fixing MPEG-TS in MP4 container of "(.+)"\s*$/,
  /\[download\] Destination:\s*(.+)$/,
  /\[download\]\s+(.+?) has already been downloaded/
]

/**
 * yt-dlp'nin bildirdiği yollardan diskte duran **en son** olanı seçer.
 * Birleştirme (`Merger`) sonrası parça dosyaları silindiği için son geçerli
 * satır bir parça adı olabilir; bu yüzden var olan dosya aranır. Hiçbiri
 * yoksa son bildirilen yol (amaçlanan ad) döner.
 */
export function pickExistingOutput(paths: string[], fallback = ''): string {
  for (let i = paths.length - 1; i >= 0; i--) {
    if (paths[i] && existsSync(paths[i])) return paths[i]
  }
  return paths[paths.length - 1] || fallback
}

/** yt-dlp ve ffmpeg binary'lerinin yerini bulur. */
export class ToolLocator extends EventEmitter {
  private settings: Settings
  private ytdlpCache: string | null | undefined
  private ffmpegCache: string | null | undefined

  constructor(settings: Settings) {
    super()
    this.settings = settings
  }

  updateSettings(settings: Settings): void {
    this.settings = settings
    this.ytdlpCache = undefined
    this.ffmpegCache = undefined
  }

  /** PATH + bilinen kurulum konumlarında yt-dlp arar. */
  findYtdlp(): string | null {
    if (this.ytdlpCache !== undefined) return this.ytdlpCache
    this.ytdlpCache = this.locate(
      this.settings.social.ytdlpPath,
      ['yt-dlp.exe', 'yt-dlp', 'youtube-dl.exe', 'youtube-dl'],
      ['yt-dlp', 'youtube-dl']
    )
    return this.ytdlpCache
  }

  findFfmpeg(): string | null {
    if (this.ffmpegCache !== undefined) return this.ffmpegCache
    this.ffmpegCache = this.locate(this.settings.social.ffmpegPath, ['ffmpeg.exe', 'ffmpeg'], ['ffmpeg'])
    return this.ffmpegCache
  }

  private locate(configured: string, files: string[], commands: string[]): string | null {
    if (configured && existsSync(configured)) return configured
    const dirs = [
      join(appResourcesDir(), 'bin'),
      join(process.cwd(), 'bin'),
      join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
      join(homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
      join(homedir(), 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin'
    ]
    const pathDirs = (process.env.PATH || '').split(delimiter)
    for (const d of [...pathDirs, ...dirs]) {
      if (!d) continue
      for (const f of files) {
        try {
          const p = join(d, f)
          if (existsSync(p)) return p
        } catch {
          /* yoksay */
        }
      }
    }
    // PATH'teki komut adını da dene (cmd üzerinden)
    for (const cmd of commands) {
      try {
        const which =
          process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`
        const out = execSync(which, { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .split(/\r?\n/)[0]
          .trim()
        if (out && existsSync(out)) return out
      } catch {
        /* yoksay */
      }
    }
    return null
  }

  /** yt-dlp yoksa indirme yolunu gösteren hata üret */
  missingYtdlpError(): Error {
    return new Error(
      `yt-dlp bulunamadı — Ayarlar → Sosyal medya bölümünden indirebilirsiniz (${this.settings.social.ytdlpPath || 'PATH'})`
    )
  }

  missingFfmpegError(): Error {
    return new Error(`ffmpeg bulunamadı — Ayarlar → Sosyal medya bölümünden belirtin`)
  }
}

function appResourcesDir(): string {
  // Packaged: process.resourcesPath; dev: proje kökü / resources
  if (process.resourcesPath && existsSync(process.resourcesPath)) {
    return process.resourcesPath
  }
  return join(process.cwd(), 'resources')
}

/** Netscape biçiminde geçici çerez dosyası yazar, yolunu döndürür. */
export async function writeCookieFile(
  cookies: import('@shared/types').CookieRecord[],
  tmpDir: string
): Promise<string> {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by IDMS2', '']
  for (const c of cookies) {
    const domain = c.domain || ''
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const httpOnly = c.httpOnly ? 'TRUE' : 'FALSE'
    const expiry = Math.floor(c.expirationDate || Math.floor(Date.now() / 1000) + 86400 * 30)
    const path = c.path || '/'
    if (!c.name || c.value === undefined) continue
    // domain, includeSubdomains, path, secure, expiry, name, value
    lines.push([domain, includeSub, path, secure, expiry, c.name, c.value].join('\t'))
  }
  const file = join(tmpDir, `cookies_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`)
  await fsp.mkdir(tmpDir, { recursive: true })
  await fsp.writeFile(file, lines.join('\n'), 'utf8')
  return file
}

/** yt-dlp süreçlerini çalıştıran sarmalayıcı. */
export class YtdlpRunner extends EventEmitter {
  private locator: ToolLocator
  private tmpDir: string

  constructor(locator: ToolLocator, tmpDir: string) {
    super()
    this.locator = locator
    this.tmpDir = tmpDir
  }

  private async buildEnv(): Promise<NodeJS.ProcessEnv> {
    const env = { ...process.env }
    const ff = this.locator.findFfmpeg()
    if (ff) {
      // ffmpeg'in dizinini PATH'e ekle ki yt-dlp bulsun
      const dir = ff.replace(/[\\/][^\\/]+$/, '')
      env.PATH = `${dir}${delimiter}${env.PATH || ''}`
    }
    return env
  }

  private async baseArgs(
    extra: string[],
    cookieFile?: string,
    ffmpegPath?: string,
    cookiesFromBrowser?: string
  ): Promise<string[]> {
    const args = [...BASE_ARGS]
    const ff = ffmpegPath || this.locator.findFfmpeg()
    if (ff) args.push('--ffmpeg-location', ff)
    if (cookieFile) args.push('--cookies', cookieFile)
    else if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser)
    if (this.locator.findYtdlp()?.toLowerCase().includes('youtube-dl')) {
      // youtube-dl geri uyumluluk: bazı bayraklar yok
      return [...extra]
    }
    return [...args, ...extra]
  }

  /** Biçim listesini (indirmeden önce seçim için) çeker. */
  async probe(opts: {
    url: string
    cookies?: import('@shared/types').CookieRecord[]
    useCookies: boolean
    impersonate: boolean
  }): Promise<MediaProbeResult> {
    const bin = this.locator.findYtdlp()
    if (!bin) throw this.locator.missingYtdlpError()

    let cookieFile: string | undefined
    let browser: string | undefined
    if (opts.useCookies) {
      if (opts.cookies && opts.cookies.length > 0) {
        cookieFile = await writeCookieFile(opts.cookies, this.tmpDir)
      } else {
        // Eklenti çerez göndermediyse (uygulamaya yapıştırılan adres) yt-dlp
        // doğrudan tarayıcı profilinden çerez alsın: Reddit/Instagram gibi
        // oturum isteyen sitelerde "authentication required" hatasını önler.
        browser = cookiesBrowser()
      }
    }

    const base = ['-J', opts.url]
    if (opts.impersonate) {
      // yt-dlp modern sürümlerde --impersonate izni gerektirir; curl_cffi yoksa yoksay
      base.splice(0, 0, '--no-check-certificate')
    }

    // YouTube, tarayıcı oturumunun çerezleriyle oynatıcı istemcisini
    // engelleyebiliyor ("Video unavailable. This content isn't available,
    // try again later"); video tarayıcıda oynasa bile liste alınamıyor.
    // Bu yüzden çerezli deneme başarısız olursa konuk olarak ve farklı bir
    // oynatıcı istemcisiyle yeniden denenir.
    const youtube = isYoutubeUrl(opts.url)
    const hasCookies = !!(cookieFile || browser)
    const attempts: { withCookies: boolean; extra: string[] }[] = []
    if (hasCookies) attempts.push({ withCookies: true, extra: [] })
    if (youtube) {
      attempts.push({ withCookies: false, extra: [] })
      attempts.push({
        withCookies: false,
        extra: ['--extractor-args', 'youtube:player_client=default,-web']
      })
    } else if (!attempts.length) {
      attempts.push({ withCookies: false, extra: [] })
    }

    let firstError = ''
    let lastError = ''
    try {
      for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i]
        // Farklı istemci denemesi yalnızca istemci kaynaklı hatalarda anlamlı
        if (i > 0 && attempt.extra.length && !needsClientFallback(lastError)) break
        try {
          const args = await this.baseArgs(
            [...attempt.extra, ...base],
            attempt.withCookies ? cookieFile : undefined,
            undefined,
            attempt.withCookies ? browser : undefined
          )
          const stdout = await this.runRaw(bin, args, 90000)
          return await this.probeResult(JSON.parse(stdout), opts.url)
        } catch (e: any) {
          const message = String(e?.message || e)
          if (!firstError) firstError = message
          lastError = message
          // Kalıcı hatalarda (özel/silinmiş video, desteklenmeyen adres)
          // yeniden denemek yalnızca gecikme ekler.
          if (!isRetryableProbeError(message)) break
        }
      }
      return {
        ok: false,
        pageUrl: opts.url,
        title: '',
        extractor: '',
        formats: [],
        error: firstError || 'yt-dlp hatası'
      }
    } finally {
      if (cookieFile) fsp.unlink(cookieFile).catch(() => undefined)
    }
  }

  /** yt-dlp JSON çıktısını biçim listesine çevirir (eksik boyutlar HEAD ile tamamlanır). */
  private async probeResult(info: any, url: string): Promise<MediaProbeResult> {
    const result = normalizeProbe(info, url)

    // yt-dlp bazı sitelerde (ve doğrudan dosyalarda) boyut bildirmez;
    // seçim tablosunda "—" kalmasın diye kalanlar HEAD ile tamamlanır.
    // Boyut sorgusu başarısız olsa bile biçim listesi dönmeli.
    const urls = new Map<string, string>()
    for (const f of Array.isArray(info?.formats) ? info.formats : []) {
      if (f?.format_id && typeof f.url === 'string') urls.set(String(f.format_id), f.url)
    }
    try {
      await fillMissingFormatSizes(result.formats, urls, result.pageUrl || url)
    } catch {
      /* boyutlar eksik kalsa da liste kullanılabilir */
    }

    return result
  }

  /** Gerçek indirme; ilerleme satırları olay olarak yayınlanır. */
  async download(
    opts: YtdlpOptions & { useCookies?: boolean; impersonate?: boolean },
    cb: {
      onProgress?: (p: YtdlpProgress) => void
      onStart?: (name: string) => void
      onOutput?: (line: string) => void
    } = {},
    signal?: AbortSignal
  ): Promise<{ filePath: string; rawLines: string[] }> {
    const bin = this.locator.findYtdlp()
    if (!bin) throw this.locator.missingYtdlpError()

    await fsp.mkdir(opts.saveDir, { recursive: true })

    let cookieFile: string | undefined
    let browser: string | undefined
    if (opts.useCookies) {
      if (opts.cookies && opts.cookies.length > 0) {
        cookieFile = await writeCookieFile(opts.cookies, this.tmpDir)
      } else {
        browser = cookiesBrowser()
      }
    }

    const quality = opts.quality || 'best'
    const ffmpeg = opts.ffmpegPath || this.locator.findFfmpeg()
    const extra: string[] = ['-o', join(opts.saveDir, opts.filenameTemplate || '%(title)s.%(ext)s')]

    if (quality === 'audio') {
      if (opts.formatId) {
        // Panelden seçilen ses dosyası (M4A/Opus…): yeniden kodlamadan indir
        extra.push('-f', opts.formatId)
      } else {
        extra.push('-x', '--audio-format', 'mp3', '--audio-quality', '0')
      }
    } else if (opts.formatId) {
      // Seçilen video kalitesi; ses ayrıysa en iyi sesle birleştir
      extra.push('-f', `${opts.formatId}+bestaudio/best`)
    } else {
      extra.push('-f', 'bestvideo*+bestaudio/best')
    }

    // HLS (m3u8) video ayrı ses akışıyla birleştirilirken yt-dlp'nin yerel
    // indiricisi zaman damgasız MPEG-TS parçalarını .mp4 içine yazıyor; ffmpeg
    // birleştirmesi "Conversion failed!" ile bitiyor (yt-dlp fixup'ı birleştirme
    // girdilerinde çalışmıyor). FFmpeg indiricisi geçerli bir dosya üretir.
    if (quality !== 'audio' && ffmpeg) extra.push('--downloader', 'm3u8:ffmpeg')

    // Hatalı bir denemeden kalan bozuk parçalar (ör. zaman damgasız .fNNN.mp4)
    // yeniden denenirken kullanılmasın; hepsi baştan indirilsin.
    if (opts.forceOverwrite) extra.push('--force-overwrites')

    if (opts.pageUrl) extra.push('--referer', opts.pageUrl)
    if (opts.impersonate) extra.push('--no-check-certificate')

    const args = await this.baseArgs(extra, cookieFile, opts.ffmpegPath, browser)
    args.push(opts.url)
    const env = await this.buildEnv()

    const lines: string[] = []
    /** yt-dlp'nin bildirdiği çıktı yolları (en son geçerli olan seçilir) */
    const outputPaths: string[] = []
    /** Son görülen akış boyutu: "[download] 12.3% of 42.76MiB …" */
    let streamBytes: number | null = null

    await this.runStream(bin, args, {
      signal,
      env,
      onLine: (line) => {
        lines.push(line)
        cb.onOutput?.(line)

        const sizeMatch = /\[download\].*?\bof\s+~?\s*([\d.]+)\s*([KMG])i?B/.exec(line)
        if (sizeMatch) {
          const parsed = parseSize(sizeMatch[1], sizeMatch[2])
          if (parsed > 0) streamBytes = parsed
        }

        const dlMatch = /\[download\]\s+([\d.]+)%/.exec(line)
        if (dlMatch) {
          const percent = parseFloat(dlMatch[1]) / 100
          const speedMatch = /at\s+([\d.]+[KMG]?i?B\/s)/.exec(line)
          const etaMatch = /ETA\s+(\d+:\d+(?::\d+)?)/.exec(line)
          cb.onProgress?.({
            percent: isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0,
            speed: speedMatch ? parseSpeed(speedMatch[1]) : 0,
            etaSeconds: etaMatch ? parseEta(etaMatch[1]) : null,
            totalBytes: streamBytes,
            statusLine: line.replace(/^\[download\]\s+/, '').trim()
          })
        } else if (line.startsWith('[Merger]') || line.startsWith('[ffmpeg]')) {
          cb.onProgress?.({
            percent: 0.98,
            speed: 0,
            etaSeconds: null,
            totalBytes: streamBytes,
            statusLine: line
          })
        } else if (line.startsWith('[ExtractAudio]')) {
          cb.onProgress?.({
            percent: 0.99,
            speed: 0,
            etaSeconds: null,
            totalBytes: streamBytes,
            statusLine: line
          })
        }

        for (const re of OUTPUT_PATH_PATTERNS) {
          const m = re.exec(line)
          if (m) {
            outputPaths.push(m[1].trim())
            break
          }
        }
      }
    })

    if (cookieFile) fsp.unlink(cookieFile).catch(() => undefined)

    // Parça dosyaları birleştirmeden sonra silinir; diskte duran en son yolu
    // bildir. Hiçbiri yoksa son bilinen yola geri düş.
    const filePath = pickExistingOutput(outputPaths, opts.saveDir)
    return { filePath, rawLines: lines }
  }

  /** yt-dlp sürümünü (hakkında/kurulum kontrolü için) */
  async version(): Promise<string | null> {
    const bin = this.locator.findYtdlp()
    if (!bin) return null
    try {
      const out = await this.runRaw(bin, ['--version'], 10000)
      return out.trim()
    } catch {
      return null
    }
  }

  private runRaw(bin: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr?.slice(-500) || err.message))
          else resolve(stdout)
        }
      )
    })
  }

  private runStream(
    bin: string,
    args: string[],
    handlers: { onLine: (line: string) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        windowsHide: true,
        env: handlers.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const kill = () => {
        try {
          child.kill()
        } catch {
          /* yoksay */
        }
      }
      handlers.signal?.addEventListener('abort', kill, { once: true })

      // Hata durumunda kullanıcılara gösterilecek asıl yt-dlp mesajı
      // (ör. "[youtube] xxx: This video is unavailable")
      let lastErrorLine = ''
      const emit = (line: string) => {
        if (line.startsWith('ERROR:')) lastErrorLine = line.slice(6).trim()
        handlers.onLine(line)
      }

      let buffer = ''
      const consume = (data: Buffer) => {
        buffer += data.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '')
          buffer = buffer.slice(idx + 1)
          if (line.trim()) emit(line)
        }
      }

      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)

      child.on('error', (err) => reject(err))
      child.on('close', (code, signal) => {
        if (buffer.trim()) emit(buffer.trim())
        if (signal || handlers.signal?.aborted) {
          reject(new Error('İndirme iptal edildi'))
        } else if (code === 0) {
          resolve()
        } else {
          reject(
            new Error(
              lastErrorLine
                ? `yt-dlp: ${lastErrorLine.slice(0, 300)}`
                : `yt-dlp çıkış kodu ${code}`
            )
          )
        }
      })
    })
  }
}

/* ---------- Biçim normalizasyonu ---------- */

/** YouTube (ve kısaltmaları) adresi mi? */
function isYoutubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)
  } catch {
    return false
  }
}

/**
 * Yeniden denemeye değer hata mı? Kalıcı hatalarda (özel/silinmiş video,
 * desteklenmeyen adres) ikinci bir yt-dlp çağrısı yalnızca gecikme ekler.
 */
function isRetryableProbeError(message: string): boolean {
  const text = String(message || '')
  if (/unsupported url|is not a valid url|http error 404|\b410\b/i.test(text)) return false
  return /unavailable|isn'?t available|not available|try again later|rate.?limit|too many requests|\b429\b|sign ?in|log ?in|cookie|authenticat|private|members[- ]only|age.?restrict|forbidden|\b403\b|reload|bot/i.test(
    text
  )
}

/** Oynatıcı istemcisi engellendiğinde farklı istemciyle denemek işe yarar. */
function needsClientFallback(message: string): boolean {
  return /unavailable|isn'?t available|try again later|rate.?limit|too many requests|\b429\b|reload|player response/i.test(
    String(message || '')
  )
}

function normalizeProbe(info: any, pageUrl: string): MediaProbeResult {
  const formats: MediaFormat[] = []
  const raw: any[] = Array.isArray(info.formats) ? info.formats : []

  for (const f of raw) {
    if (!f || !f.format_id) continue
    const vcodec = f.vcodec && f.vcodec !== 'none' ? f.vcodec : null
    const acodec = f.acodec && f.acodec !== 'none' ? f.acodec : null
    const isAudioOnly = !vcodec && !!acodec
    const protocol = String(f.protocol || '')
    const hls = /m3u8/i.test(protocol)

    // Anlamsız/jpegselleri ve çok küçük protokol parçalarını ele
    if (f.ext === 'mhtml' || f.ext === 'm3u8_native') continue

    const resolution =
      f.resolution && f.resolution !== 'audio only'
        ? f.resolution
        : f.height
          ? `${f.width || '?'}x${f.height}`
          : null

    formats.push({
      formatId: String(f.format_id),
      ext: f.ext || 'mp4',
      resolution,
      fps: f.fps ?? null,
      vcodec,
      acodec,
      tbr: f.tbr ?? null,
      sizeBytes: f.filesize ?? f.filesize_approx ?? null,
      note: [f.format_note, f.protocol].filter(Boolean).join(' · '),
      isAudioOnly,
      protocol,
      hls
    })
  }

  // Sırala: önce video, sonra ses; aynı grupta DASH (https) HLS'ten önce
  // (HLS parçaları ayrı sesle birleştirilemiyor), sonra bit hızına göre azalan
  formats.sort((a, b) => {
    if (a.isAudioOnly !== b.isAudioOnly) return a.isAudioOnly ? 1 : -1
    if (!!a.hls !== !!b.hls) return a.hls ? 1 : -1
    return (b.tbr || 0) - (a.tbr || 0)
  })

  return {
    ok: true,
    pageUrl: info.original_url || info.webpage_url || pageUrl,
    title: info.title || info.fulltitle || '',
    extractor: info.extractor_key || info.extractor || '',
    thumbnail: info.thumbnail || undefined,
    durationSeconds: typeof info.duration === 'number' ? info.duration : null,
    formats
  }
}

/**
 * yt-dlp'nin boyut bildirmediği biçimler için HEAD isteğiyle `Content-Length`
 * sorgular. HLS/DASH yayınlarında tek dosya boyutu olmadığından atlanır.
 * Toplam süre bütçelidir; boyut bulunamazsa satır "—" olarak kalır.
 */
async function fillMissingFormatSizes(
  formats: MediaFormat[],
  urls: Map<string, string>,
  pageUrl: string
): Promise<void> {
  const targets = formats.filter(
    (f) => !f.hls && !(typeof f.sizeBytes === 'number' && f.sizeBytes > 0) && urls.has(f.formatId)
  )
  if (targets.length === 0) return

  const deadline = Date.now() + 3000
  const queue = [...targets]

  const worker = async (): Promise<void> => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const left = deadline - Date.now()
      if (left <= 0) return
      try {
        const probe = await probeUrl(urls.get(row.formatId) as string, {
          pageUrl,
          timeoutMs: Math.min(2000, left)
        })
        if (probe.ok && typeof probe.sizeBytes === 'number' && probe.sizeBytes > 0) {
          row.sizeBytes = probe.sizeBytes
        }
      } catch {
        /* boyut bilinmiyorsa satır boyutsuz kalır */
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()))
}

function parseSpeed(s: string): number {
  const m = /^([\d.]+)([KMG]i?)?B\/s$/i.exec(s)
  if (!m) return 0
  const v = parseFloat(m[1])
  const unit = (m[2] || '').toUpperCase()
  const mult =
    unit.startsWith('K') ? 1024 : unit.startsWith('M') ? 1024 ** 2 : unit.startsWith('G') ? 1024 ** 3 : 1
  return Math.round(v * mult)
}

/** yt-dlp ilerleme satırındaki "42.76MiB" benzeri boyutu bayta çevirir. */
function parseSize(value: string, unit: string): number {
  const v = parseFloat(value)
  if (!isFinite(v)) return 0
  const u = unit.toUpperCase()
  const mult = u === 'K' ? 1024 : u === 'M' ? 1024 ** 2 : u === 'G' ? 1024 ** 3 : 1
  return Math.round(v * mult)
}

function parseEta(s: string): number | null {
  const parts = s.split(':').map((p) => parseInt(p, 10))
  if (parts.some((p) => !isFinite(p))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

/** yt-dlp'in desteklediği sitelerin kısa listesi (UI ipucu için) */
export const SUPPORTED_SITES = [
  'YouTube',
  'Instagram',
  'Facebook',
  'Reddit',
  'TikTok',
  'X / Twitter',
  'Vimeo',
  'Twitch',
  'Kick',
  'Dailymotion',
  'SoundCloud',
  'Pinterest',
  'VK',
  'Bilibili',
  '+1000 site'
]
