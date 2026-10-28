import type { DownloadItem } from '@shared/types'
import { useT } from '../i18n'

const api = () => window.idms2

interface Props {
  selected: DownloadItem[]
  unreadCount: number
  onAdd: () => void
  onTorrent: () => void
  onSettings: () => void
  onToggleNotifications: () => void
  onRefresh: () => void
  onDelete: (ids: string[], deleteFile: boolean) => void
  onStart: (ids: string[]) => void
  onPause: (ids: string[]) => void
  onOpenDownloads: () => void
  onClearCompleted: () => void
}

export function Toolbar({
  selected,
  unreadCount,
  onAdd,
  onTorrent,
  onSettings,
  onToggleNotifications,
  onRefresh,
  onDelete,
  onStart,
  onPause,
  onOpenDownloads,
  onClearCompleted
}: Props) {
  const t = useT()
  const ids = selected.map((d) => d.id)
  const hasSel = selected.length > 0
  const anyActive = selected.some((d) => d.state === 'downloading' || d.state === 'queued')
  const anyPaused = selected.some(
    (d) => d.state === 'paused' || d.state === 'error' || d.state === 'canceled'
  )

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">⤓</span>
        <span>IDMS2</span>
      </div>

      <button className="tbtn primary" onClick={onAdd} title={`${t('toolbar.addHint')} (Ctrl+J)`}>
        <span className="ico">＋</span>
        {t('toolbar.add')}
      </button>

      <button className="tbtn" onClick={onTorrent} title={t('toolbar.newTorrent')}>
        <span className="ico">🧲</span>
        {t('toolbar.newTorrent')}
      </button>

      <div style={{ width: 1, height: 26, background: 'var(--border-soft)', margin: '0 4px' }} />

      <button
        className="tbtn"
        disabled={!hasSel || !anyPaused}
        onClick={() => onStart(ids)}
        title={t('toolbar.startHint')}
      >
        <span className="ico">▶</span>
        {t('toolbar.start')}
      </button>

      <button
        className="tbtn"
        disabled={!hasSel || !anyActive}
        onClick={() => onPause(ids)}
        title={t('toolbar.pauseHint')}
      >
        <span className="ico">⏸</span>
        {t('toolbar.pause')}
      </button>

      <button
        className="tbtn"
        disabled={!hasSel}
        onClick={() => {
          if (
            selected.length === 1 ||
            window.confirm(
              `${selected.length} ${t('toolbar.remove').toLowerCase()}?`
            )
          ) {
            onDelete(ids, false)
          }
        }}
        title={t('toolbar.removeHint')}
      >
        <span className="ico">🗑</span>
        {t('toolbar.remove')}
      </button>

      <button className="tbtn" onClick={onClearCompleted} title={t('action.clearCompleted')}>
        <span className="ico">✓</span>
        {t('toolbar.completed')}
      </button>

      <button className="tbtn" onClick={onOpenDownloads} title={t('toolbar.completedHint')}>
        <span className="ico">📁</span>
      </button>

      <div className="spacer" />

      <button className="tbtn" onClick={onRefresh} title={t('common.retry')}>
        <span className="ico">⟳</span>
      </button>

      <button
        className="tbtn"
        onClick={onToggleNotifications}
        title={t('toolbar.notifyHint')}
        style={{ position: 'relative' }}
      >
        <span className="ico">🔔</span>
        {unreadCount > 0 && <span className="badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      <button className="tbtn" onClick={onSettings} title={t('toolbar.settingsHint')}>
        <span className="ico">⚙</span>
        {t('toolbar.settings')}
      </button>
    </header>
  )
}
