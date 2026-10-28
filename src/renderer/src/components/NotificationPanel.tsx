import type { AppToast } from '@shared/types'
import { useT, getLang } from '../i18n'

interface Props {
  toasts: AppToast[]
  onClose: () => void
  onClear: () => void
}

const STAGE_LABEL: Record<AppToast['stage'], string> = {
  start: 'start',
  progress: 'progress',
  complete: 'complete',
  error: 'error',
  info: 'info'
}

/** Bildirim merkezi: önceki bildirimlerin tam geçmişi. */
export function NotificationPanel({ toasts, onClose, onClear }: Props) {
  const t = useT()
  const lang = getLang()

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 140 }}
        onClick={onClose}
      />
      <div className="notif-panel" style={{ zIndex: 150 }}>
        <div className="np-head">
          <span>🔔</span>
          <span>{t('menu.notifications')}</span>
          <span className="grow" />
          <button className="btn ghost" style={{ height: 27 }} onClick={onClear}>
            {t('menu.clearAll')}
          </button>
          <button className="d-close" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="np-list">
          {toasts.length === 0 && (
            <div className="np-empty">{t('menu.noNotifications')}</div>
          )}
          {toasts.map((n) => (
            <div key={n.id} className="np-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="stage">{t('notify.toastQueue')} · {STAGE_LABEL[n.stage]}</div>
                <div className="np-title">{n.title}</div>
                <div className="np-msg">{n.message}</div>
                <div className="np-msg muted" style={{ fontSize: 11, marginTop: 3 }}>
                  {new Date(n.createdAt).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
