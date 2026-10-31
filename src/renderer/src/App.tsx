import { useEffect, useMemo, useState } from 'react'
import type { AppToast, CategoryId, CookieRecord, DownloadItem } from '@shared/types'
import { useAppState } from './state'
import { useT, setLang } from './i18n'
import { formatBytes, formatSpeed, iconFor } from './format'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { DownloadList } from './components/DownloadList'
import { StatusBar } from './components/StatusBar'
import { ToastStack } from './components/ToastStack'
import { NotificationPanel } from './components/NotificationPanel'
import { ConfirmDownloadDialog } from './dialogs/ConfirmDownloadDialog'
import { MediaDialog } from './dialogs/MediaDialog'
import { TorrentDialog } from './dialogs/TorrentDialog'
import { SettingsDialog } from './dialogs/SettingsDialog'

const api = () => window.idms2

export type DialogKind =
  | { kind: 'none' }
  | {
      kind: 'media'
      url: string
      pageUrl?: string
      title?: string
      /** Eklentinin sayfadan topladığı oturum çerezleri (Reddit/Instagram) */
      cookies?: CookieRecord[]
    }
  | { kind: 'torrent' }
  | { kind: 'settings'; tab?: string }

export default function App() {
  const st = useAppState()
  const t = useT()
  const [category, setCategory] = useState<CategoryId | 'all'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<DialogKind>({ kind: 'none' })
  const [notifOpen, setNotifOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Ayarlara göre tema + dil uygula
  useEffect(() => {
    if (!st.settings) return
    const theme = st.settings.general.theme
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.lang = st.settings.general.language
    setLang(st.settings.general.language)
  }, [st.settings?.general.theme, st.settings?.general.language])

  // Sistem teması canlı değişimi
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (st.settings?.general.theme === 'system') {
        document.documentElement.setAttribute(
          'data-theme',
          mq.matches ? 'dark' : 'light'
        )
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [st.settings?.general.theme])

  // Yüzen panelde "Formatlar…" → medya penceresi
  useEffect(() => {
    return api().onOpenMedia((media) => {
      setDialog({
        kind: 'media',
        url: media.url,
        pageUrl: media.pageUrl,
        title: media.title,
        cookies: media.cookies
      })
    })
  }, [])

  // Sürükle-bırak ile URL ekleme
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('text/uri-list') || e.dataTransfer?.types.includes('text/plain')) {
        e.preventDefault()
        setDragging(true)
      }
    }
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain')
      if (!text) return
      const url = text.split(/\r?\n/)[0].trim()
      if (/^https?:\/\//i.test(url)) {
        void api().openAddDownloadWindow(url)
      }
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // Kısayollar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Delete' && selected) {
        void api().removeDownload(selected, false)
      } else if (e.key === 'Escape') {
        setDialog({ kind: 'none' })
        setNotifOpen(false)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        void api().openAddDownloadWindow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const d of st.downloads) {
      c[d.category] = (c[d.category] || 0) + 1
      if (d.state === 'downloading' || d.state === 'queued' || d.state === 'resolving') {
        c.downloading = (c.downloading || 0) + 1
      } else if (d.state === 'completed') {
        c.completed = (c.completed || 0) + 1
      } else if (d.state === 'error') {
        c.error = (c.error || 0) + 1
      } else if (d.state === 'paused') {
        c.paused = (c.paused || 0) + 1
      } else if (d.state === 'scheduled') {
        c.scheduled = (c.scheduled || 0) + 1
      }
    }
    return c
  }, [st.downloads])

  const filtered = useMemo(() => {
    let items = st.downloads
    if (category !== 'all') {
      items = items.filter((d) => matchesCategory(d, category))
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      items = items.filter(
        (d) => d.name.toLowerCase().includes(q) || d.url.toLowerCase().includes(q)
      )
    }
    return items
  }, [st.downloads, category, query])

  const selectedItems = useMemo(
    () => (selected ? st.downloads.filter((d) => d.id === selected) : []),
    [st.downloads, selected]
  )

  if (!st.ready) {
    return (
      <div className="empty" style={{ height: '100vh' }}>
        <span className="spin" />
        <p>{t('common.loading')}</p>
      </div>
    )
  }

  return (
    <div className="app">
      <Toolbar
        selected={selectedItems}
        unreadCount={st.toasts.length}
        onAdd={() => void api().openAddDownloadWindow()}
        onTorrent={() => setDialog({ kind: 'torrent' })}
        onSettings={() => setDialog({ kind: 'settings' })}
        onToggleNotifications={() => setNotifOpen((v) => !v)}
        onRefresh={async () => st.setDownloads(await api().listDownloads())}
        onDelete={(ids, deleteFile) => {
          void Promise.all(ids.map((id) => api().removeDownload(id, deleteFile)))
          setSelected(null)
        }}
        onStart={(ids) => ids.forEach((id) => void api().startDownload(id))}
        onPause={(ids) => ids.forEach((id) => void api().pauseDownload(id))}
        onOpenDownloads={async () => {
          const s = await api().getSettings()
          void api().openPath(s.general.downloadDir)
        }}
        onClearCompleted={() => void api().clearCompleted()}
      />

      <div className="main">
        <Sidebar category={category} counts={counts} onSelect={setCategory} />
        <div className="content">
          <div className="searchbar">
            <input
              placeholder={t('search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="badge-inline">
              {filtered.length} {t('status.downloads')}
            </span>
            {selectedItems.length > 0 && (
              <span className="badge-inline accent">{selectedItems.length} {t('menu.selectAll')}</span>
            )}
          </div>

          <DownloadList
            items={filtered}
            selectedId={selected}
            onSelect={setSelected}
            onAction={(id, action) => {
              const a = api()
              switch (action) {
                case 'start':
                  void a.startDownload(id)
                  break
                case 'pause':
                  void a.pauseDownload(id)
                  break
                case 'remove':
                  void a.removeDownload(id, false)
                  break
                case 'details':
                  void a.openProgressWindow(id)
                  break
                case 'open': {
                  const it = st.downloads.find((d) => d.id === id)
                  if (it?.savePath) void a.openPath(it.savePath)
                  break
                }
                case 'showFolder': {
                  const it = st.downloads.find((d) => d.id === id)
                  if (it) void a.showItemInFolder(it.savePath)
                  break
                }
                case 'queue':
                  void a.queueDownload(id)
                  break
                case 'copy': {
                  const item = st.downloads.find((d) => d.id === id)
                  if (item) void navigator.clipboard.writeText(item.url)
                  break
                }
              }
            }}
          />
        </div>
      </div>

      <StatusBar
        downloads={st.downloads}
        serverStatus={st.serverStatus}
        onOpenExtension={() => setDialog({ kind: 'settings', tab: 'extension' })}
      />

      {/* Bildirim balonları */}
      <ToastStack
        toasts={st.toasts}
        onDismiss={(id) => st.dismissToast(id)}
        onOpenSettings={() => setDialog({ kind: 'settings', tab: 'notifications' })}
        onAction={(toast, action) => handleToastAction(toast, action, st)}
      />

      {notifOpen && (
        <NotificationPanel
          toasts={st.toasts}
          onClose={() => setNotifOpen(false)}
          onClear={() => void st.clearToasts()}
        />
      )}

      {/* Diyaloglar */}
      {dialog.kind === 'media' && (
        <MediaDialog
          url={dialog.url}
          pageUrl={dialog.pageUrl}
          initialTitle={dialog.title}
          cookies={dialog.cookies}
          onClose={() => setDialog({ kind: 'none' })}
          onDownloaded={(id) => setSelected(id)}
        />
      )}

      {dialog.kind === 'torrent' && (
        <TorrentDialog
          onClose={() => setDialog({ kind: 'none' })}
          onAdded={(id) => setSelected(id)}
        />
      )}

      {dialog.kind === 'settings' && (
        <SettingsDialog
          initialTab={dialog.tab}
          settings={st.settings}
          serverStatus={st.serverStatus}
          onChange={st.applySettings}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}

      {/* İndirmeden önce onay penceresi */}
      {st.confirmItem && (
        <ConfirmDownloadDialog
          item={st.confirmItem}
          onDecide={(id, savePath, start) => {
            void api().confirmDownload(id, savePath, start)
            st.setConfirmItem(null)
            if (start) setSelected(id)
          }}
          onCancel={(id) => {
            void api().cancelDownload(id)
            st.setConfirmItem(null)
          }}
        />
      )}

      {dragging && <div className="drop-veil">{t('drop.hint')}</div>}
    </div>
  )
}

function matchesCategory(d: DownloadItem, cat: CategoryId): boolean {
  switch (cat) {
    case 'downloading':
      return d.state === 'downloading' || d.state === 'queued' || d.state === 'resolving'
    case 'completed':
      return d.state === 'completed'
    case 'paused':
      return d.state === 'paused'
    case 'error':
      return d.state === 'error'
    case 'scheduled':
      return d.state === 'scheduled'
    case 'queued':
      return d.state === 'queued'
    default:
      return d.category === cat
  }
}

function handleToastAction(
  toast: AppToast,
  action: string,
  st: ReturnType<typeof useAppState>
): void {
  const a = window.idms2
  if (action === 'open-folder' && toast.downloadId) {
    const item = st.downloads.find((d) => d.id === toast.downloadId)
    if (item) void a.showItemInFolder(item.savePath)
  } else if (action === 'retry' && toast.downloadId) {
    void a.startDownload(toast.downloadId)
  } else if (action === 'settings') {
    void a.getSettings()
  }
}
