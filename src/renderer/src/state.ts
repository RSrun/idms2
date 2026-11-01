import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppToast,
  DownloadItem,
  ExtensionEvent,
  ExtensionServerStatus,
  Settings
} from '@shared/types'
import { setLang } from './i18n'

const api = () => window.idms2

/** Uygulama genelindeki paylaşılan durum: indirmeler, ayarlar, bildirimler. */
export function useAppState() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [toasts, setToasts] = useState<AppToast[]>([])
  const [serverStatus, setServerStatus] = useState<ExtensionServerStatus | null>(null)
  const [extEvents, setExtEvents] = useState<ExtensionEvent[]>([])
  const [ready, setReady] = useState(false)
  const pendingConfirm = useRef<DownloadItem | null>(null)
  const [confirmItem, setConfirmItem] = useState<DownloadItem | null>(null)
  // Aynı anda birden çok .torrent inebilir: onay isteklerini sırayla göster.
  const [torrentConfirmQueue, setTorrentConfirmQueue] = useState<DownloadItem[]>([])

  useEffect(() => {
    let unsubs: Array<() => void> = []
    ;(async () => {
      try {
        const [s, items, status, storedToasts] = await Promise.all([
          api().getSettings(),
          api().listDownloads(),
          api().getServerStatus(),
          api().listToasts()
        ])
        setLang(s.general.language)
        setSettings(s)
        setDownloads(items)
        setServerStatus(status)
        setToasts(storedToasts || [])
        setReady(true)
      } catch (e) {
        console.error('init failed', e)
        setReady(true)
      }

      unsubs.push(
        api().onDownloadsChanged((items) => setDownloads(items)),
        api().onDownloadProgress((item) => {
          setDownloads((prev) => prev.map((d) => (d.id === item.id ? item : d)))
        }),
        api().onToast((toast) => {
          setToasts((prev) => [toast, ...prev].slice(0, 80))
        }),
        api().onServerStatus((st) => setServerStatus(st)),
        api().onExtensionEvent((evt) => {
          setExtEvents((prev) => [evt, ...prev].slice(0, 20))
        }),
        api().onSettings((s) => {
          setLang(s.general.language)
          setSettings(s)
        }),
        api().onConfirmRequired((item) => {
          pendingConfirm.current = item
          setConfirmItem(item)
        }),
        api().onTorrentFileComplete((item) => {
          setTorrentConfirmQueue((prev) =>
            prev.some((d) => d.id === item.id) ? prev : [...prev, item]
          )
        })
      )
    })()

    return () => {
      unsubs.forEach((u) => {
        try {
          u()
        } catch {
          /* yoksay */
        }
      })
      unsubs = []
    }
  }, [])

  const applySettings = useCallback(async (patch: any) => {
    const next = await api().patchSettings(patch)
    setLang(next.general.language)
    setSettings(next)
    return next
  }, [])

  const clearToasts = useCallback(async () => {
    const rest = await api().clearToasts()
    setToasts(rest || [])
  }, [])

  /** Tek bir balonu gizle (yerel liste + kalıcı liste). */
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id))
    void api()
      .clearToasts(id)
      .catch(() => undefined)
  }, [])

  /** Sıradaki .torrent onay isteğini kapat. */
  const dismissTorrentConfirm = useCallback(() => {
    setTorrentConfirmQueue((prev) => prev.slice(1))
  }, [])

  return {
    ready,
    downloads,
    setDownloads,
    settings,
    setSettings,
    applySettings,
    toasts,
    clearToasts,
    dismissToast,
    serverStatus,
    extEvents,
    confirmItem,
    setConfirmItem,
    torrentConfirmItem: torrentConfirmQueue[0] ?? null,
    dismissTorrentConfirm
  }
}
