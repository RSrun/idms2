import { useEffect, useState } from 'react'
import type { DownloadItem } from '@shared/types'
import { useT } from '../i18n'
import { formatBytes } from '../format'

const api = () => window.idms2

interface Props {
  item: DownloadItem
  onDecide: (id: string, savePath?: string, start?: boolean) => void
  onCancel: (id: string) => void
}

/**
 * "İndirmeden önce" bildirim penceresi (IDM'nin indirme bilgisi penceresi gibi):
 * dosya adı, kaynak, boyut ve hedef gösterilir; Başlat / İptal seçenekleri vardır.
 */
export function ConfirmDownloadDialog({ item, onDecide, onCancel }: Props) {
  const t = useT()
  const [saveDir, setSaveDir] = useState<string | null>(null)
  const [live, setLive] = useState<DownloadItem>(item)

  useEffect(() => {
    setLive(item)
  }, [item])

  useEffect(() => {
    void api()
      .getSettings()
      .then((s) => setSaveDir(s.general.downloadDir))
      .catch(() => setSaveDir(''))
    // Çözümleme tamamlanınca boyut adı güncellensin
    const un = api().onDownloadsChanged((items) => {
      const fresh = items.find((d) => d.id === item.id)
      if (fresh) setLive(fresh)
    })
    return un
  }, [item.id])

  const folder = saveDir ? `${saveDir}\\${live.category}` : live.savePath

  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-label={t('confirm.title')}>
        <div className="d-head">
          <span className="brand-mark" style={{ width: 30, height: 30, fontSize: 17 }}>
            ⬇
          </span>
          <div>
            <h2>{t('confirm.title')}</h2>
            <div className="sub">{t('confirm.from')}: {hostOf(live.url)}</div>
          </div>
        </div>

        <div className="d-body" style={{ gap: 10 }}>
          <div className="confirm-icon">⤓</div>
          <p className="confirm-q">{t('confirm.question')}</p>
          <p className="confirm-name">
            <b>{live.name}</b>
          </p>

          <dl className="info-grid">
            <dt>{t('col.size')}</dt>
            <dd>
              {live.progress.totalBytes > 0
                ? formatBytes(live.progress.totalBytes)
                : t('add.sizeUnknown')}
            </dd>
            <dt>{t('add.saveTo')}</dt>
            <dd style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{folder}</dd>
            <dt>{t('add.category')}</dt>
            <dd>{live.category}</dd>
            <dt>{t('confirm.from')}</dt>
            <dd style={{ wordBreak: 'break-all' }}>{live.url}</dd>
          </dl>

          <div className="muted" style={{ fontSize: 11.5, textAlign: 'center' }}>
            {t('set.confirmBeforeHint')}
          </div>
        </div>

        <div className="d-foot" style={{ justifyContent: 'center', gap: 12 }}>
          <button className="btn" onClick={() => onCancel(live.id)}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={() => onDecide(live.id, undefined, true)}>
            ⬇ {t('confirm.download')}
          </button>
        </div>
      </div>
    </div>
  )
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return u.slice(0, 50)
  }
}
