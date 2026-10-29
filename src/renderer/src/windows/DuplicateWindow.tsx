import { useEffect, useState } from 'react'
import type { DownloadItem, DownloadWindowRequest, Settings } from '@shared/types'
import { useT } from '../i18n'
import { baseOf } from './shared'

interface Props {
  request: DownloadWindowRequest
  existing?: DownloadItem
  settings: Settings
}

type Choice = 'number' | 'overwrite' | 'continue'

/** IDM'nin "Aynı indirme bağlantısı" penceresi. */
export function DuplicateWindow({ request, existing, settings }: Props) {
  const t = useT()
  const [choice, setChoice] = useState<Choice>(
    settings.general.duplicatePolicy && settings.general.duplicatePolicy !== 'ask'
      ? settings.general.duplicatePolicy
      : 'number'
  )
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    document.title = t('win.duplicate.title')
  }, [t])

  const name = request.name || (request.url ? baseOf(request.url) : existing?.name || '')

  return (
    <div className="dlwin dupwin">
      <div className="field-row">
        <label htmlFor="dup-url">{t('win.duplicate.url')}</label>
        <input id="dup-url" className="text mono" value={request.url} readOnly />
      </div>

      <p className="dup-explain">{t('win.duplicate.explain')}</p>

      <div className="dup-options" role="radiogroup">
        <label className="radio">
          <input
            type="radio"
            name="dup"
            checked={choice === 'number'}
            onChange={() => setChoice('number')}
          />
          {t('win.duplicate.number')}
        </label>
        <label className="radio">
          <input
            type="radio"
            name="dup"
            checked={choice === 'overwrite'}
            onChange={() => setChoice('overwrite')}
          />
          {t('win.duplicate.overwrite')}
        </label>
        <label className="radio">
          <input
            type="radio"
            name="dup"
            checked={choice === 'continue'}
            onChange={() => setChoice('continue')}
          />
          {t('win.duplicate.continue')}
        </label>
      </div>

      <div className="dup-meta">
        {name ? (
          <span>
            {t('win.duplicate.file')}: <b>{name}</b>
          </span>
        ) : null}
        {existing ? (
          <span>
            {t('win.duplicate.status')}: <b>{t(`state.${existing.state}` as any)}</b>
          </span>
        ) : null}
      </div>

      <div className="dup-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => void window.dlwin.action({ type: 'duplicate-choose', choice, remember })}
        >
          {t('win.duplicate.ok')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void window.dlwin.action({ type: 'duplicate-cancel' })}
        >
          {t('win.duplicate.cancel')}
        </button>
      </div>

      <label className="check dup-remember">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        {t('win.duplicate.remember')}
      </label>
      <div className="muted tiny">{t('win.duplicate.hint')}</div>
    </div>
  )
}
