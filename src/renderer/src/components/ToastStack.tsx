import { useEffect, useRef, useState } from 'react'
import type { AppToast } from '@shared/types'
import { useT } from '../i18n'

interface Props {
  toasts: AppToast[]
  onDismiss: (id: string) => void
  onOpenSettings: () => void
  onAction: (toast: AppToast, action: string) => void
}

/** Uygulama içi bildirim balonları: önce, sırasında ve sonra. */
export function ToastStack({ toasts, onDismiss, onAction }: Props) {
  const t = useT()
  const [visible, setVisible] = useState<AppToast[]>([])
  const leaving = useRef(new Set<string>())

  // En yeni 4 balon; 6 sn sonra kendiliğinden kapanır (hata 9 sn)
  useEffect(() => {
    const fresh = toasts.slice(0, 4)
    setVisible(fresh)
    const timers = fresh.map((toast) =>
      setTimeout(() => dismiss(toast.id), toast.stage === 'error' ? 9000 : 6000)
    )
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toasts])

  const dismiss = (id: string) => {
    if (leaving.current.has(id)) return
    leaving.current.add(id)
    setVisible((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)) as any)
    setTimeout(() => {
      leaving.current.delete(id)
      onDismiss(id)
    }, 200)
  }

  if (visible.length === 0) return null

  return (
    <div className="toasts" role="status" aria-live="polite">
      {visible.map((toast) => (
        <div key={toast.id} className={`toast ${toast.stage} ${toast.leaving ? 'leaving' : ''}`}>
          <span className="tico">{stageIcon(toast.stage)}</span>
          <div className="tbody">
            <div className="ttitle">{toast.title}</div>
            <div className="tmsg">{toast.message}</div>

            {toast.stage === 'start' && (
              <div className="tactions">
                <button onClick={() => onAction(toast, 'open-settings')}>{t('toolbar.settings')}</button>
              </div>
            )}
            {toast.stage === 'complete' && (
              <div className="tactions">
                <button onClick={() => onAction(toast, 'open-folder')}>{t('action.openFolder')}</button>
              </div>
            )}
            {toast.stage === 'error' && toast.downloadId && (
              <div className="tactions">
                <button onClick={() => onAction(toast, 'retry')}>{t('common.retry')}</button>
                <button onClick={() => onAction(toast, 'open-settings')}>
                  {t('toolbar.settings')}
                </button>
              </div>
            )}
          </div>
          <button className="tclose" onClick={() => dismiss(toast.id)} aria-label={t('common.close')}>
            ✕
          </button>
          {toast.stage === 'progress' && typeof toast.percent === 'number' && (
            <span
              className="tprogress"
              style={{ width: `${Math.round(toast.percent * 100)}%` }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function stageIcon(stage: AppToast['stage']): string {
  switch (stage) {
    case 'start':
      return '⤳'
    case 'progress':
      return '⬇'
    case 'complete':
      return '✓'
    case 'error':
      return '!'
    default:
      return 'ℹ'
  }
}
