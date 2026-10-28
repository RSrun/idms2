import { useEffect, useRef, useState } from 'react'
import type { CategoryId, UrlProbeResult } from '@shared/types'
import { useT } from '../i18n'
import { formatBytes } from '../format'

const api = () => window.idms2

interface Props {
  initialUrl?: string
  onClose: () => void
  onAdded: (id: string) => void
}

const CATEGORIES: Array<{ id: CategoryId; key: Parameters<ReturnType<typeof useT>>[0] }> = [
  { id: 'video', key: 'cat.video' },
  { id: 'audio', key: 'cat.audio' },
  { id: 'archive', key: 'cat.archive' },
  { id: 'program', key: 'cat.program' },
  { id: 'document', key: 'cat.document' },
  { id: 'other', key: 'cat.other' }
]

/** "İndirme ekle" penceresi: URL + sunucu bilgisi önizlemesi. */
export function AddDownloadDialog({ initialUrl, onClose, onAdded }: Props) {
  const t = useT()
  const [url, setUrl] = useState(initialUrl || '')
  const [name, setName] = useState('')
  const [saveDir, setSaveDir] = useState('')
  const [category, setCategory] = useState<CategoryId | ''>('')
  const [startNow, setStartNow] = useState(true)
  const [probe, setProbe] = useState<UrlProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState('')
  const urlRef = useRef<HTMLInputElement>(null)

  // Kaydedilen varsayılan klasörü yükle
  useEffect(() => {
    void api()
      .getSettings()
      .then((s) => setSaveDir(s.general.downloadDir))
  }, [])

  useEffect(() => {
    urlRef.current?.focus()
    if (initialUrl) void runProbe(initialUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runProbe(u: string): Promise<void> {
    if (!/^https?:\/\//i.test(u)) {
      setProbe(null)
      return
    }
    setProbing(true)
    setError('')
    try {
      const res = await api().probeUrl(u)
      setProbe(res)
      if (res.ok && res.name && res.name !== 'download' && !name) {
        setName(res.name)
      }
      if (!res.ok && res.error) setError(t('add.probeFailed'))
    } catch {
      setError(t('add.probeFailed'))
    } finally {
      setProbing(false)
    }
  }

  async function submit(): Promise<void> {
    const u = url.trim()
    if (!/^https?:\/\//i.test(u)) {
      setError(t('add.invalidUrl'))
      urlRef.current?.focus()
      return
    }
    try {
      const res = await api().addDownload({
        url: u,
        name: name.trim() || undefined,
        savePath: undefined,
        category: category || undefined,
        silent: !startNow ? false : undefined
      })
      onAdded(res.id)
      onClose()
    } catch (e: any) {
      setError(e?.message || t('err.generic'))
    }
  }

  async function pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setUrl(text.trim())
        void runProbe(text.trim())
      }
    } catch {
      /* pano izni yok */
    }
  }

  const valid = /^https?:\/\//i.test(url.trim())

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={t('add.title')}>
        <div className="d-head">
          <span className="brand-mark" style={{ width: 30, height: 30, fontSize: 17 }}>
            ⤓
          </span>
          <div>
            <h2>{t('add.title')}</h2>
            <div className="sub">{t('toolbar.addHint')}</div>
          </div>
          <button className="d-close" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        <div className="d-body">
          <div className="field">
            <label>{t('add.url')}</label>
            <div className="row">
              <input
                ref={urlRef}
                className="input"
                placeholder="https://example.com/file.zip"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => void runProbe(url.trim())}
                onKeyDown={(e) => e.key === 'Enter' && void runProbe(url.trim())}
                spellCheck={false}
              />
              <button className="btn" onClick={() => void pasteFromClipboard()}>
                {t('add.paste')}
              </button>
            </div>
          </div>

          {probing && (
            <div className="muted" style={{ fontSize: 12 }}>
              <span className="spin" /> {t('add.probing')}
            </div>
          )}

          {probe?.ok && (
            <dl className="info-grid">
              <dt>{t('add.name')}</dt>
              <dd>{probe.name}</dd>
              <dt>{t('col.size')}</dt>
              <dd>
                {probe.sizeBytes ? formatBytes(probe.sizeBytes) : t('add.sizeUnknown')}
              </dd>
              <dt>{t('confirm.from')}</dt>
              <dd>{probe.host}</dd>
              <dt>{t('col.type')}</dt>
              <dd>
                {probe.contentType || '—'} ·{' '}
                {probe.supportsRange ? (
                  <span className="ok">{t('add.supportsRange')}</span>
                ) : (
                  <span className="warn">{t('add.noRange')}</span>
                )}
              </dd>
            </dl>
          )}

          {error && (
            <div
              className="card"
              style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
            >
              <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
            </div>
          )}

          <div className="field">
            <label>{t('add.name')}</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('add.name')}
            />
          </div>

          <div className="field">
            <label>{t('add.saveTo')}</label>
            <div className="row">
              <input className="input" value={saveDir} readOnly />
              <button
                className="btn"
                onClick={async () => {
                  const dir = await api().pickDirectory(saveDir)
                  if (dir) setSaveDir(dir)
                }}
              >
                {t('common.browse')}
              </button>
            </div>
          </div>

          <div className="field">
            <label>{t('add.category')}</label>
            <select
              className="select"
              value={category}
              onChange={(e) => setCategory(e.target.value as CategoryId | '')}
            >
              <option value="">{t('common.default')}</option>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {t(c.key)}
                </option>
              ))}
            </select>
          </div>

          <div className="setting-row" style={{ borderBottom: 'none', paddingTop: 2 }}>
            <div className="txt">
              <div className="lbl">{t('add.startNow')}</div>
            </div>
            <div className="ctrl">
              <button
                className={`switch ${startNow ? 'on' : ''}`}
                onClick={() => setStartNow((v) => !v)}
                aria-pressed={startNow}
                aria-label={t('add.startNow')}
              />
            </div>
          </div>
        </div>

        <div className="d-foot">
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            {valid && probe?.ok ? `URL ✓` : ''}
          </span>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => void submit()}>
            ⬇ {t('add.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
