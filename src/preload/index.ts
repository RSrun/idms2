import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AddDownloadRequest,
  AppToast,
  DeepPartial,
  DownloadItem,
  ExtensionEvent,
  ExtensionServerStatus,
  FloatAction,
  FloatMediaInfo,
  FloatPanelState,
  IpcApi,
  MediaDownloadRequest,
  MediaProbeResult,
  Settings,
  UrlProbeResult
} from '@shared/types'

/**
 * Renderer'a açılan güvenli API yüzeyi.
 * Tüm IPC kanalları buradan geçer; renderer doğrudan ipcRenderer göremez.
 */
const api: IpcApi = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch: DeepPartial<Settings>) => ipcRenderer.invoke('settings:patch', patch),
  pickDirectory: (defaultPath?: string) => ipcRenderer.invoke('dialog:pickDirectory', defaultPath),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  getExtensionDir: () => ipcRenderer.invoke('ext:dir'),
  showItemInFolder: (p: string) => ipcRenderer.invoke('shell:showItemInFolder', p),

  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  addDownload: (req: AddDownloadRequest) => ipcRenderer.invoke('downloads:add', req),
  probeUrl: (url: string, pageUrl?: string) => ipcRenderer.invoke('downloads:probe', url, pageUrl),
  startDownload: (id: string) => ipcRenderer.invoke('downloads:start', id),
  pauseDownload: (id: string) => ipcRenderer.invoke('downloads:pause', id),
  queueDownload: (id: string) => ipcRenderer.invoke('downloads:queue', id),
  resumeDownload: (id: string) => ipcRenderer.invoke('downloads:resume', id),
  cancelDownload: (id: string) => ipcRenderer.invoke('downloads:cancel', id),
  removeDownload: (id: string, deleteFile: boolean) =>
    ipcRenderer.invoke('downloads:remove', id, deleteFile),
  confirmDownload: (id: string, savePath?: string, start?: boolean) =>
    ipcRenderer.invoke('downloads:confirm', id, savePath, start),
  scheduleDownload: (id: string, at: number | null) =>
    ipcRenderer.invoke('downloads:schedule', id, at),
  pickSavePathFor: (id: string) => ipcRenderer.invoke('downloads:pickSavePath', id),
  clearCompleted: () => ipcRenderer.invoke('downloads:clearCompleted'),

  probeMedia: (url: string, pageUrl?: string, cookies?: any[]) =>
    ipcRenderer.invoke('media:probe', url, pageUrl, cookies) as Promise<MediaProbeResult>,
  downloadMedia: (req: MediaDownloadRequest) => ipcRenderer.invoke('media:download', req),

  addTorrent: (input: { magnetOrPath: string; saveDir?: string }) =>
    ipcRenderer.invoke('torrent:add', input),
  pickTorrentFile: () => ipcRenderer.invoke('dialog:pickTorrent'),

  getServerStatus: () => ipcRenderer.invoke('ext:status') as Promise<ExtensionServerStatus>,
  regeneratePairingCode: () => ipcRenderer.invoke('ext:regenerateCode'),
  getPairingCode: () => ipcRenderer.invoke('ext:code'),
  revokeExtensionPairing: () =>
    ipcRenderer.invoke('ext:revoke') as Promise<ExtensionServerStatus>,

  sendTestNotification: (stage: 'start' | 'progress' | 'complete' | 'error') =>
    ipcRenderer.invoke('notify:test', stage),
  markAllNotificationsRead: () => ipcRenderer.invoke('notify:clear'),

  onDownloadsChanged: (cb: (items: DownloadItem[]) => void) =>
    subscribe('downloads', cb),
  onDownloadProgress: (cb: (item: DownloadItem) => void) => subscribe('progress', cb),
  onToast: (cb: (toast: AppToast) => void) => subscribe('toast', cb),
  onExtensionEvent: (cb: (evt: ExtensionEvent) => void) => subscribe('extension-event', cb),
  onServerStatus: (cb: (status: ExtensionServerStatus) => void) => subscribe('server-status', cb),
  onOpenMedia: (cb: (media: FloatMediaInfo) => void) => subscribe('open-media', cb)
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** Renderer'a ek alanlar (tip güvenliği korunarak) */
const extra = {
  /** Onay penceresi required olayı */
  onConfirmRequired: (cb: (item: DownloadItem) => void) => subscribe('confirm-required', cb),
  /** Ayar değişikliği */
  onSettings: (cb: (s: Settings) => void) => subscribe('settings', cb),
  /** Medya indirme iptali */
  cancelMedia: (id: string) => ipcRenderer.invoke('media:cancel', id),
  /** Bildirim listesi */
  listToasts: (): Promise<AppToast[]> => ipcRenderer.invoke('notify:toasts'),
  clearToasts: (id?: string): Promise<AppToast[]> => ipcRenderer.invoke('notify:clear', id),
  openExternal: (u: string) => ipcRenderer.invoke('shell:openExternal', u),
  /** URL kontrolü (probe) tipi */
  probe: (url: string, pageUrl?: string): Promise<UrlProbeResult> =>
    ipcRenderer.invoke('downloads:probe', url, pageUrl),
  /** Pencere kontrolleri (özel başlık çubuğu için) */
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized')
  },
  /** yt-dlp'i resmi kaynaktan indir (Ayarlar → Sosyal medya) */
  fetchYtdlp: (): Promise<string> => ipcRenderer.invoke('social:fetchYtdlp'),
  /** Binary dahil dosyayı userData/bin altına yaz */
  saveToolFile: (fileName: string, base64: string): Promise<string> =>
    ipcRenderer.invoke('tools:saveFile', fileName, base64),
  /** Yüzen IDMS paneli (video/ses üzerine binen pencere) */
  float: {
    state: (): Promise<FloatPanelState | null> => ipcRenderer.invoke('float:state'),
    action: (action: FloatAction): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('float:action', action),
    onMedia: (cb: (state: FloatPanelState) => void) => subscribe('float:media', cb),
    onStatus: (cb: (status: { message: string; tone: 'info' | 'error' | 'success' }) => void) =>
      subscribe('float:status', cb)
  }
}

export type ExtendedApi = IpcApi & typeof extra

contextBridge.exposeInMainWorld('idms2', { ...api, ...extra })
