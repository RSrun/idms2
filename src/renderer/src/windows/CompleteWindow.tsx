import { useEffect, useState } from 'react'
import type { DownloadItem, Settings } from '@shared/types'
import { useT } from '../i18n'
import { formatBytes } from '../format'
import { baseOf, fileBadge } from './shared'

interface Props {
  item: DownloadItem
  settings: Settings
}

/** IDM'nin "İndirme tamamlandı" penceresi. */
export function CompleteWindow({ item, settings }: Props) {
  const t = useT()
  const [dontShow, setDontShow] = useState(settings.notifications.completeWindow === false)

  useEffect(() => {
    document.title = t('win.complete.title')
  }, [t])

  const badge = fileBadge(item.name)
  const bytes = item.progress.totalBytes || item.progress.downloadedBytes

  return (
    <div className="dlwin completewin">
      <div className="complete-head">
        <div className={`file-badge big ${badge.kind}`}>{badge.text}</div>
        <div className="complete-text">
          <div className="complete-title">{t('win.complete.title')}</div>
          <div className="complete-line">
            {t('win.complete.line', {
              size: formatBytes(bytes),
              bytes: Math.round(bytes).toLocaleString()
            })}
          </div>
        </div>
      </div>

      <div className="field-row top">
        <label htmlFor="done-addr">{t('win.complete.address')}</label>
        <input id="done-addr" className="text mono" value={item.url} readOnly />
      </div>

      <div className="field-row">
        <label htmlFor="done-path">{t('win.complete.saved')}</label>
        <input id="done-path" className="text mono" value={item.savePath} readOnly />
      </div>

      <div className="complete-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void window.idms2.openPath(item.savePath)
            void window.dlwin.action({ type: 'complete-open' })
          }}
        >
          {t('win.complete.open')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void window.idms2.openWith(item.savePath)
            void window.dlwin.action({ type: 'complete-open-with' })
          }}
        >
          {t('win.complete.openWith')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void window.idms2.showItemInFolder(item.savePath)
            void window.dlwin.action({ type: 'complete-folder' })
          }}
        >
          {t('win.complete.folder')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void window.dlwin.action({ type: 'complete-close' })}
        >
          {t('win.complete.close')}
        </button>
      </div>

      <label className="check dont-show">
        <input
          type="checkbox"
          checked={dontShow}
          onChange={(e) => {
            setDontShow(e.target.checked)
            void window.idms2.patchSettings({
              notifications: { completeWindow: !e.target.checked }
            })
          }}
        />
        {t('win.complete.dontShow')}
      </label>

      <div className="muted tiny" title={baseOf(item.savePath)}>
        {item.kind === 'media' ? item.media?.site || '' : ''}
      </div>
    </div>
  )
}
