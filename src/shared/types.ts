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
  /** Kullanıcının indirme penceresinde girdiği açıklama */
  description?: string
  /** Sunucu Range (devam/çoklu bağlantı) destekliyor mu */
  supportsRange?: boolean
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
  /**
   * Kategori başına hatırlanan kayıt klasörü (IDM'nin "bu kategori için
   * bu yolu hatırla" seçeneği). Anahtar CategoryId ya da özel kategori adı.
   */
  categoryDirs?: Record<string, string>
  /** "Kategori +" ile eklenen özel klasörler */
  customCategories?: Array<{ name: string; dir: string }>
  /**
   * Aynı URL tekrar eklendiğinde ne yapılsın:
   * ask = pencereyi göster, number = numaralı kopya, overwrite = üzerine yaz,
   * continue = mevcut indirmeye devam et (tamamlandıysa bitiş penceresi).
   */
  duplicatePolicy?: 'ask' | 'number' | 'overwrite' | 'continue'
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
  /** İndirme sırasında IDM tarzı ilerleme penceresi */
  progressWindow?: boolean
  /** İndirme bitince "İndirme tamamlandı" penceresi */
  completeWindow?: boolean
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
  /** Sayfada çizilen yüzen IDMS paneli (yalnızca tarayıcı sekmesinde yaşar) */
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
  /**
   * Oynatıcının ağdan aldığı HLS/DASH manifesti (m3u8/mpd). Reddit gibi
   * sitelerde oynatıcı tek bir <source> gösterir; kaliteler manifesttedir.
   */
  manifest?: string
  /**
   * Eklentinin sayfa için topladığı oturum çerezleri. Reddit/Instagram gibi
   * giriş isteyen sitelerde yt-dlp'ye `--cookies` olarak verilir.
   */
  cookies?: CookieRecord[]
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
  /** Satırın indirileceği HTTP adresi; akış (m3u8/mpd) ise yt-dlp çözer */
  url?: string
  /** Listenin en iyi seçeneği */
  best?: boolean
}

/**
 * Yüzen panelin kalite listesi yanıtı. Panel artık tarayıcı sayfasının içinde
 * çizilir; uygulama yalnızca listeyi ve dilini üretir.
 */
export interface FloatFormatsReply {
  ok: boolean
  formats: FloatFormat[]
  /** Liste boşsa/hata varsa panelde gösterilecek kısa not */
  note?: string
  language: 'tr' | 'en'
}

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
  addTorrent(input: { magnetOrPath: string; saveDir?: string }): Promise<{
    id: string
    torrentId?: string
    /** Torrent zaten ekliydi; yeni kayıt açılmadı */
    duplicate?: boolean
  }>
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
  description?: string
  /** Onay penceresi açmadan doğrudan başlat */
  silent?: boolean
  /** false ise kayıt kuyruğa eklenir ama hemen başlatılmaz */
  start?: boolean
  headers?: Record<string, string>
}

/* ------------------------------------------------------------------------ */
/* IDM tarzı indirme pencereleri (öncesi / sırasında / sonrası / aynı URL)   */
/* ------------------------------------------------------------------------ */

export type DownloadWindowMode = 'add' | 'progress' | 'complete' | 'duplicate'

/** Pencerenin istediği ekleme bilgisi (henüz indirme kaydı oluşmamış olabilir) */
export interface DownloadWindowRequest {
  url: string
  pageUrl?: string
  name?: string
  savePath?: string
  category?: CategoryId
  description?: string
  silent?: boolean
  /** false ise pencere onayından sonra indirme kuyruğa eklenir */
  start?: boolean
}

/** İlerleme penceresindeki bağlantı (segment) satırı */
export interface DownloadWindowSegment {
  index: number
  start: number
  end: number
  received: number
  /** Segmentin bayt cinsinden toplam boyutu */
  size: number
  done: boolean
}

export interface DownloadWindowState {
  mode: DownloadWindowMode
  settings: Settings
  /** İlerleme ve tamamlandı pencereleri için kayıt */
  item?: DownloadItem
  /** Ekleme penceresi için istek */
  request?: DownloadWindowRequest
  /** Aynı bağlantı penceresinde mevcut kayıt */
  existing?: DownloadItem
  /** İlerleme penceresi için canlı segmentler */
  segments?: DownloadWindowSegment[]
}

export type DownloadWindowAction =
  | { type: 'add-start'; request: DownloadWindowRequest; remember: boolean }
  | { type: 'add-later'; request: DownloadWindowRequest; remember: boolean }
  | { type: 'add-cancel' }
  | { type: 'progress-pause' }
  | { type: 'progress-resume' }
  | { type: 'progress-cancel' }
  | { type: 'progress-open-file' }
  | { type: 'progress-open-folder' }
  | { type: 'complete-open'; dontShowAgain?: boolean }
  | { type: 'complete-open-with'; dontShowAgain?: boolean }
  | { type: 'complete-folder'; dontShowAgain?: boolean }
  | { type: 'complete-close'; dontShowAgain?: boolean }
  | { type: 'duplicate-choose'; choice: 'number' | 'overwrite' | 'continue'; remember: boolean }
  | { type: 'duplicate-cancel' }
  | { type: 'set-speed-limit'; mbps: number }
  | { type: 'set-complete-window'; value: boolean }

export interface DownloadWindowApi {
  state(): Promise<DownloadWindowState>
  action(action: DownloadWindowAction): Promise<unknown>
  onUpdate(cb: (state: DownloadWindowState) => void): () => void
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
  /** yt-dlp akış protokolü: "https", "m3u8_native"… (boş = bilinmiyor) */
  protocol?: string
  /**
   * HLS (m3u8) akışı. yt-dlp'nin yerel HLS indiricisi parçaları MPEG-TS
   * olarak .mp4'e yazıyor ve ayrı ses akışıyla birleştirme "Conversion
   * failed!" ile bitiyor; bu yüzden aynı çözünürlükte DASH (https)
   * biçimi varsa o tercih edilir.
   */
  hls?: boolean
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

/**
 * Kurulu Firefox / Zen profili ve eklenti durumu.
 * Gecko tarayıcılar imzasız eklentiyi kendiliğinden yüklemez; uygulama profili
 * `xpinstall.signatures.required=false` ile hazırlar (bkz. extGecko.ts).
 */
export interface GeckoProfile {
  browser: 'zen' | 'firefox'
  browserName: string
  /** Tarayıcı çalıştırılabilir dosyası (bulunamazsa boş) */
  exe: string
  profileDir: string
  profileName: string
  /** Tarayıcının varsayılan (açılışta kullandığı) profili mi */
  isDefault: boolean
  /** Eklenti profile kalıcı olarak kurulu mu */
  installed: boolean
  /** about:debugging ile bırakılmış paketsiz klasör var mı */
  unpacked: boolean
  signaturesDisabled: boolean
  running: boolean
}

/** Eklenti kurulum/kaldırma sonucu */
export interface GeckoInstallResult {
  ok: boolean
  error?: string
  /** Tarayıcı açıktı; eklenti yeniden başlatmada yüklenir */
  running?: boolean
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
      /**
       * Sayfa içi yüzen panelin kalite listesi isteği. Panel tarayıcıda
       * çizildiği için konum/odak bilgisi gerekmez; uygulama yalnızca
       * listeyi hazırlar.
       */
      t: 'float-formats'
      /** Aynı medyayı eşlemek için panelin ürettiği anahtar */
      key?: string
      media: FloatMediaInfo
      reqId?: string
    }
  | {
      t: 'float-download'
      key?: string
      /** Listeden seçilen satırın türü */
      kind: 'video' | 'audio'
      /** Panelde listelenen satırın kimliği; yoksa en iyi seçenek indirilir */
      formatId?: string
      media: FloatMediaInfo
      reqId?: string
    }
  | {
      t: 'float-action'
      action: 'formats' | 'open-app'
      key?: string
      media?: FloatMediaInfo
      reqId?: string
    }
  | { t: 'probe'; url: string }
  | { t: 'unpair' }
  | { t: 'open-app' }
  | { t: 'ping' }

export type AppToExtMessage =
  | { t: 'welcome'; appVersion: string; paired: boolean; pairingCode?: string }
  | { t: 'pong' }
  | { t: 'ack'; ref?: string; ok: boolean; message?: string; id?: string }
  | { t: 'status'; active: number; totalSpeed: number; items: Array<{ id: string; name: string; percent: number; state: DownloadState }> }
  | { t: 'toast'; title: string; message: string; stage: 'start' | 'progress' | 'complete' | 'error' }
  | ({ t: 'float-formats'; reqId?: string } & FloatFormatsReply)
  | { t: 'float-download'; reqId?: string; ok: boolean; message?: string }
  /** Tarayıcı paneli ayarı değişti (panel sayfada çizilir) */
  | { t: 'config'; floatingPanel: boolean; enabled?: boolean }
