/**
 * Uygulama genelinde paylaşılan veri sözleşmeleri.
 * Main, preload ve renderer tarafından import edilir.
 */

export type DownloadState =
  | 'queued'
  | 'resolving'
  | 'confirming'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'canceled'
  | 'scheduled'

export type DownloadKind = 'http' | 'torrent' | 'media'

export type CategoryId =
  | 'all'
  | 'downloading'
  | 'completed'
  | 'queued'
  | 'scheduled'
  | 'paused'
  | 'error'
  | 'video'
  | 'audio'
  | 'archive'
  | 'program'
  | 'document'
  | 'other'

/** Tarayıcı eklentisinden gelen / uygulamanın verdiği medya kaynağı */
export interface MediaCandidate {
  /** Benzersiz anahtar (url + format) */
  id: string
  url: string
  /** Sayfa URL'si (Referer / cookies için) */
  pageUrl?: string
  title?: string
  container?: string
  quality?: string
  fps?: number
  /** Byte cinsinden; bilinmiyorsa null */
  sizeBytes?: number | null
  /** tadyen onaylanmadıysa true */
  needsConfirm?: boolean
}

/** Eklentinin sayfada bulduğu indirilebilir öğeler */
export interface DetectedMedia {
  id: string
  kind: 'video' | 'audio' | 'file'
  url: string
  title: string
  pageUrl: string
  /** Örn. "video/mp4" */
  mime?: string
  sizeBytes?: number | null
  /** Video elementindeki mevcut süre (saniye) */
  duration?: number
}

export interface DownloadProgress {
  /** 0..1 */
  percent: number
  downloadedBytes: number
  totalBytes: number
  /** Bayt/sn */
  speed: number
  etaSeconds: number | null
  /** Aktif bağlantı (segment) sayısı */
  connections: number
}

export interface DownloadItem {
  id: string
  kind: DownloadKind
  name: string
  url: string
  pageUrl?: string
  savePath: string
  category: CategoryId
  state: DownloadState
  progress: DownloadProgress
  createdAt: number
  startedAt?: number
  finishedAt?: number
  errorMessage?: string
  /** Torrent içindir */
  torrent?: {
    magnetOrPath: string
    peers: number
    downloadSpeed: number
    uploadSpeed: number
    ratio: number
    progress: number
    totalBytes: number
    downloadedBytes: number
  }
  /** Sosyal medya (yt-dlp) içindir */
  media?: {
    site?: string
    formatId?: string
    /** İndirme sırasında yt-dlp çıktısından gelen durum satırı */
    statusLine?: string
    /** varsayılan format seçimi: video+ses, sadece ses, en iyi */
    wantedQuality?: 'best' | 'audio'
  }
  /** Zamanlanmış başlatma (epoch ms) */
  scheduledAt?: number
}

export interface GeneralSettings {
  language: 'tr' | 'en'
  theme: 'light' | 'dark' | 'system'
  downloadDir: string
  /** Eşzamanlı indirme sayısı */
  maxConcurrent: number
  /** Bir dosya için azami segment (bağlantı) sayısı */
  segmentsPerDownload: number
  /** Hız sınırı MB/s, 0 = sınırsız */
  speedLimitMbps: number
  autoStart: boolean
  /** Kuyruğa eklenince onay penceresi aç */
  confirmBeforeDownload: boolean
  /** Panodaki bağlantıları yakala */
  monitorClipboard: boolean
  startOnBoot: boolean
  startMinimized: boolean
}

export interface NotificationSettings {
  /** İndirme başlarken (onay/planlama) */
  onStart: boolean
  /** İlerleme %25/50/75 eşiklerinde */
  onProgress: boolean
  /** Tamamlandığında */
  onComplete: boolean
  /** Hata olduğunda */
  onError: boolean
  /** Windows masaüstü bildirimi (sistem bildirimi) */
  systemToasts: boolean
  /** Uygulama içi bildirim balonu */
  inAppToasts: boolean
  /** Tamamlanınca ses çal */
  playSound: boolean
}

export interface SocialSettings {
  /** yt-dlp çalıştırılabilir dosyası (boş = PATH'te ara) */
  ytdlpPath: string
  /** ffmpeg (boş = PATH'te ara) */
  ffmpegPath: string
  /** Tarayıcı çerezlerini yt-dlp'ye aktar (giriş gerektiren içerik için) */
  passCookies: boolean
  /** Hedef: en iyi video+ses, sadece ses (mp3) */
  preferredQuality: 'best' | 'audio'
  /** İndirilecek siteler için kullanıcı aracısını taklit et */
  impersonate: boolean
}

export interface TorrentSettings {
  saveDir: string
  /** 0 = rastgele port */
  port: number
  maxConcurrent: number
  /** Yükleme limiti MB/s, 0 = sınırsız */
  uploadLimitMbps: number
  seedRatioLimit: number
  dht: boolean
  utp: boolean
}

export interface ExtensionSettings {
  /** Lokal köprü sunucusu portu (HTTP + WebSocket) */
  port: number
  /** Eklentiye gönderilen eşleştirme kodu (ilk bağlantı için) */
  pairingCode: string
  /** Eşleşen eklentilere verilen kalıcı erişim token'ı */
  token: string
  /** Token almaya yetkili eklenti kökenleri */
  allowedOrigins: string[]
  enabled: boolean
  /** Video/ses üzerinde yüzen IDMS paneli (IDM'nin yüzen paneli gibi) */
  floatingPanel: boolean
}

/** Oynatıcının sunduğu alternatif dosya (kalite) */
export interface FloatMediaSource {
  url: string
  /** "video/mp4" gibi */
  mime?: string
  /** Oynatıcının etiketi (data-quality, size, title…) */
  label?: string
}

/** Eklentinin yüzdürdüğü panelin anlattığı medya */
export interface FloatMediaInfo {
  /** Oynatıcının gördüğü adres (blob: olabilir) */
  url: string
  pageUrl: string
  title: string
  pageTitle?: string
  kind: 'video' | 'audio'
  duration?: number | null
  /** Doğrudan HTTP(S) dosyası (HLS/DASH veya blob değil) */
  direct?: boolean
  /** Adres, yt-dlp gibi bir çözücü gerektiriyor (YouTube, Instagram…) */
  needsExtractor?: boolean
  /** Oynatıcının <source> listesi (kalite seçenekleri) */
  sources?: FloatMediaSource[]
}

/** Ekran (DIP) koordinatlarında medya dikdörtgeni */
export interface FloatScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** Yüzen panelde listelenen indirme seçeneği (video kalitesi / ses dosyası) */
export interface FloatFormat {
  /** yt-dlp biçim kimliği ya da panelin kendi kimliği */
  formatId: string
  kind: 'video' | 'audio'
  /** Kısa etiket: "1080p", "MP3" */
  label: string
  /** Etiket yerine yerelleştirilecek anahtar (özgün dosya gibi) */
  labelKey?: 'origVideo' | 'origAudio' | 'audioMp3'
  /** "MP4 · 1920×1080 · 60 fps" */
  detail?: string
  sizeBytes?: number | null
  /** Doğrudan HTTP adresi (yt-dlp kullanmadan indirilir) */
  url?: string
  /** Listenin en iyi seçeneği */
  best?: boolean
}

export type FloatFormatsState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/** Yüzen panelin kendi durumu (panel sayfası bunu okur) */
export interface FloatPanelState {
  media: FloatMediaInfo | null
  expanded: boolean
  language: 'tr' | 'en'
  /** Video kaliteleri ve ses dosyaları */
  formats: FloatFormat[]
  formatsState: FloatFormatsState
  /** Kalite listesi alınamadıysa kısa açıklama */
  formatsNote?: string
}

/** Yüzen panelden gelen eylemler */
export type FloatAction =
  | { type: 'download-video' }
  | { type: 'download-audio' }
  /** Listeden seçilen kalite / ses dosyası */
  | { type: 'download-format'; formatId: string }
  | { type: 'formats' }
  | { type: 'open-app' }
  | { type: 'close' }
  | { type: 'expand' | 'collapse' }

export interface Settings {
  general: GeneralSettings
  notifications: NotificationSettings
  social: SocialSettings
  torrent: TorrentSettings
  extension: ExtensionSettings
}

/** Renderer'dan main'e giden IPC sözleşmesi */
export interface IpcApi {
  // --- Uygulama ---
  getAppInfo(): Promise<{ version: string; platform: string; electron: string }>
  getSettings(): Promise<Settings>
  patchSettings(patch: DeepPartial<Settings>): Promise<Settings>
  pickDirectory(defaultPath?: string): Promise<string | null>
  openPath(p: string): Promise<void>
  getExtensionDir(): Promise<string>
  showItemInFolder(p: string): Promise<void>

  // --- İndirmeler ---
  listDownloads(): Promise<DownloadItem[]>
  addDownload(req: AddDownloadRequest): Promise<{ id: string; state: DownloadState }>
  probeUrl(url: string, pageUrl?: string): Promise<UrlProbeResult>
  startDownload(id: string): Promise<void>
  pauseDownload(id: string): Promise<void>
  /** İndirmeyi kuyruğa al (hemen başlatmadan) */
  queueDownload(id: string): Promise<void>
  resumeDownload(id: string): Promise<void>
  cancelDownload(id: string): Promise<void>
  removeDownload(id: string, deleteFile: boolean): Promise<void>
  confirmDownload(id: string, savePath?: string, start?: boolean): Promise<DownloadItem>
  scheduleDownload(id: string, at: number | null): Promise<DownloadItem>
  pickSavePathFor(id: string): Promise<string | null>
  clearCompleted(): Promise<void>

  // --- Sosyal medya ---
  probeMedia(url: string, pageUrl?: string, cookies?: CookieRecord[]): Promise<MediaProbeResult>
  downloadMedia(req: MediaDownloadRequest): Promise<{ id: string }>

  // --- Torrent ---
  addTorrent(input: { magnetOrPath: string; saveDir?: string }): Promise<{ id: string }>
  pickTorrentFile(): Promise<string | null>

  // --- Eklenti / sunucu ---
  getServerStatus(): Promise<ExtensionServerStatus>
  regeneratePairingCode(): Promise<string>
  getPairingCode(): Promise<string>
  /** Token'ı yeniler, eşleşen tüm eklenti kökenlerini iptal eder */
  revokeExtensionPairing(): Promise<ExtensionServerStatus>

  // --- Bildirimler ---
  sendTestNotification(stage: 'start' | 'progress' | 'complete' | 'error'): Promise<void>
  markAllNotificationsRead(): Promise<void>

  // --- Olaylar (renderer dinler) ---
  onDownloadsChanged(cb: (items: DownloadItem[]) => void): () => void
  onDownloadProgress(cb: (item: DownloadItem) => void): () => void
  onToast(cb: (toast: AppToast) => void): () => void
  onExtensionEvent(cb: (evt: ExtensionEvent) => void): () => void
  onServerStatus(cb: (status: ExtensionServerStatus) => void): () => void
  /** Yüzen panelde "Formatlar…" seçilince ana pencerede medya penceresini açar */
  onOpenMedia(cb: (media: FloatMediaInfo) => void): () => void
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface AddDownloadRequest {
  url: string
  pageUrl?: string
  name?: string
  savePath?: string
  category?: CategoryId
  /** Onay penceresi açmadan doğrudan başlat */
  silent?: boolean
  headers?: Record<string, string>
}

export interface UrlProbeResult {
  ok: boolean
  url: string
  name: string
  sizeBytes: number | null
  supportsRange: boolean
  contentType: string | null
  /** sunucu adı (kaynak göstermek için) */
  host: string
  error?: string
}

export interface MediaProbeResult {
  ok: boolean
  pageUrl: string
  title: string
  extractor: string
  thumbnail?: string
  durationSeconds?: number | null
  formats: MediaFormat[]
  error?: string
}

export interface MediaFormat {
  formatId: string
  ext: string
  /** "1920x1080" gibi; ses için null */
  resolution: string | null
  fps?: number | null
  /** video/audio/both */
  vcodec: string | null
  acodec: string | null
  tbr?: number | null
  sizeBytes: number | null
  note: string
  /** audio-only ise true */
  isAudioOnly: boolean
}

export interface MediaDownloadRequest {
  url: string
  pageUrl?: string
  formatId?: string
  quality?: 'best' | 'audio'
  saveDir?: string
  name?: string
  cookies?: CookieRecord[]
  /** Kullanıcı zaten seçti (yüzen panel) → "indirmeden önce onayla" atlanır */
  silent?: boolean
}

/** chrome.cookies.getAll() çıktısı biçimi */
export interface CookieRecord {
  name: string
  value: string
  domain: string
  path: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

export interface AppToast {
  id: string
  /** hangi aşamada: başlangıç / ilerleme / tamamlandı / hata / genel */
  stage: 'start' | 'progress' | 'complete' | 'error' | 'info'
  title: string
  message: string
  downloadId?: string
  /** İlerleme bildiriminde 0..1 */
  percent?: number
  createdAt: number
  read?: boolean
  /** Kuyruktan çıkarken animasyon için (yalnızca renderer) */
  leaving?: boolean
}

export type ExtensionEvent =
  | { type: 'connected'; client: string }
  | { type: 'disconnected'; client: string }
  | { type: 'media-detected'; count: number; title: string }
  | { type: 'download-requested'; url: string; name?: string }

export interface ExtensionServerStatus {
  running: boolean
  port: number
  clients: Array<{ id: string; client: string; connectedAt: number; version?: string }>
  pairingCode: string
  /** Bağlanan eklenti var mı */
  paired: boolean
}

/** Eklenti <-> uygulama WS mesajları */
export type ExtToAppMessage =
  | { t: 'hello'; client: string; version: string; pairingCode?: string }
  | {
      t: 'detect'
      page: { url: string; title: string }
      items: Array<{
        kind: 'video' | 'audio' | 'file'
        url: string
        title: string
        mime?: string
        sizeBytes?: number | null
        duration?: number
      }>
    }
  | { t: 'download'; url: string; pageUrl?: string; name?: string; referrer?: string; mimeType?: string; cookies?: CookieRecord[] }
  | { t: 'download-media'; url: string; pageUrl?: string; quality?: 'best' | 'audio'; cookies?: CookieRecord[] }
  | {
      t: 'float'
      state: 'show' | 'update' | 'hide'
      /** panelin hangi medyaya ait olduğunu ayırt eder (URL) */
      key?: string
      media?: FloatMediaInfo
      rect?: FloatScreenRect
    }
  | { t: 'probe'; url: string }
  | { t: 'open-app' }
  | { t: 'ping' }

export type AppToExtMessage =
  | { t: 'welcome'; appVersion: string; paired: boolean; pairingCode?: string }
  | { t: 'pong' }
  | { t: 'ack'; ref?: string; ok: boolean; message?: string; id?: string }
  | { t: 'status'; active: number; totalSpeed: number; items: Array<{ id: string; name: string; percent: number; state: DownloadState }> }
  | { t: 'toast'; title: string; message: string; stage: 'start' | 'progress' | 'complete' | 'error' }
