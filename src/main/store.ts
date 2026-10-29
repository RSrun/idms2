import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import type { DownloadItem, DeepPartial, Settings } from '@shared/types'

const DIR = () => join(app.getPath('userData'), 'idms2')

const DEFAULT_SETTINGS: Settings = {
  general: {
    language: 'tr',
    theme: 'system',
    downloadDir: '',
    maxConcurrent: 3,
    segmentsPerDownload: 8,
    speedLimitMbps: 0,
    autoStart: true,
    confirmBeforeDownload: true,
    monitorClipboard: true,
    startOnBoot: false,
    startMinimized: false,
    categoryDirs: {},
    customCategories: [],
    duplicatePolicy: 'ask'
  },
  notifications: {
    onStart: true,
    onProgress: true,
    onComplete: true,
    onError: true,
    systemToasts: true,
    inAppToasts: true,
    playSound: true,
    progressWindow: true,
    completeWindow: true
  },
  social: {
    ytdlpPath: '',
    ffmpegPath: '',
    passCookies: true,
    preferredQuality: 'best',
    impersonate: true
  },
  torrent: {
    saveDir: '',
    port: 0,
    maxConcurrent: 3,
    uploadLimitMbps: 0,
    seedRatioLimit: 2,
    dht: true,
    utp: true
  },
  extension: {
    port: 9789,
    pairingCode: '',
    token: '',
    allowedOrigins: [],
    enabled: true,
    floatingPanel: true
  }
}

function deepMerge<T>(base: T, patch: any): T {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  const out: any = { ...base }
  for (const key of Object.keys(patch)) {
    const b = (base as any)[key]
    const p = patch[key]
    if (p === undefined) continue
    if (typeof p === 'object' && p !== null && !Array.isArray(p) && typeof b === 'object' && b !== null) {
      out[key] = deepMerge(b, p)
    } else {
      out[key] = p
    }
  }
  return out as T
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * Ayarları ve indirme listesini userData altında JSON olarak saklar.
 * Basit, atomik (tmp+rename) yazım ile güvenilir kalıcılık sağlar.
 */
export class Store {
  private settings: Settings
  private downloadsFile: string
  private settingsFile: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    const dir = DIR()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* zaten var */
    }
    this.settingsFile = join(dir, 'settings.json')
    this.downloadsFile = join(dir, 'downloads.json')

    const saved = readJson<Partial<Settings>>(this.settingsFile, {})
    this.settings = deepMerge(DEFAULT_SETTINGS, saved)

    // Varsayılan hedef: doğrudan "İndirlenenler" klasörü.
    // Kategoriye göre alt klasörler (video, audio, program…) manager.add'ta eklenir.
    const downloadsDir = app.getPath('downloads')
    const legacyDir = join(downloadsDir, 'IDMS2')
    let migrated = false

    if (!this.settings.general.downloadDir || this.settings.general.downloadDir === legacyDir) {
      this.settings.general.downloadDir = downloadsDir
      migrated = true
    }
    if (
      !this.settings.torrent.saveDir ||
      this.settings.torrent.saveDir === join(legacyDir, 'Torrents')
    ) {
      this.settings.torrent.saveDir = join(this.settings.general.downloadDir, 'Torrents')
      migrated = true
    }
    if (!this.settings.extension.pairingCode) {
      this.settings.extension.pairingCode = this.randomCode()
      migrated = true
    }
    if (!this.settings.extension.token) {
      this.settings.extension.token = randomBytes(24).toString('hex')
      migrated = true
    }
    if (!Array.isArray(this.settings.extension.allowedOrigins)) {
      this.settings.extension.allowedOrigins = []
      migrated = true
    }
    if (migrated) this.saveSettings()
  }

  private randomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let s = ''
    const buf = Buffer.from(
      Array.from({ length: 6 }, () => Math.floor(Math.random() * 256))
    )
    for (let i = 0; i < 6; i++) s += chars[buf[i] % chars.length]
    return s
  }

  getSettings(): Settings {
    return this.settings
  }

  patchSettings(patch: DeepPartial<Settings>): Settings {
    this.settings = deepMerge(this.settings, patch)
    this.saveSettings()
    return this.settings
  }

  saveSettings(): void {
    try {
      writeJson(this.settingsFile, this.settings)
    } catch (e) {
      console.error('[store] settings save failed', e)
    }
  }

  loadDownloads(): DownloadItem[] {
    return readJson<DownloadItem[]>(this.downloadsFile, [])
  }

  /** Indirme listesini debounce ederek yazar (sık olaylar için). */
  saveDownloads(items: DownloadItem[]): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        writeJson(this.downloadsFile, items)
      } catch (e) {
        console.error('[store] downloads save failed', e)
      }
    }, 500)
  }

  saveDownloadsNow(items: DownloadItem[]): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      writeJson(this.downloadsFile, items)
    } catch (e) {
      console.error('[store] downloads save failed', e)
    }
  }
}
