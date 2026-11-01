import { useEffect, useState } from 'react'
import type { DownloadItem, TorrentInspectResult } from '@shared/types'
import { useT } from '../i18n'
import { formatBytes } from '../format'

const api = () => window.idms2

interface Props {
  item: DownloadItem
  onDecide: () => Promise<void> | void
  onCancel: () => void
}

/**
 * .torrent dosyası indirildiğinde içeriği için onay penceresi:
 * torrent'in gerçek adı, toplam boyutu, dosya listesi ve hedef klasör gösterilir;
 * "İçeriği indir / Sonra karar ver".
 */
export function ConfirmTorrentDialog({ item, onDecide, onCancel }: Props) {
  const t = useT()
  const [saveDir, setSaveDir] = useState<string | null>(null)
  const [live, setLive] = useState<DownloadItem>(item)
  const [meta, setMeta] = useState<TorrentInspectResult | null>(null)
  const [reading, setReading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setLive(item)
    setError('')
  }, [item])

  useEffect(() => {
    void api()
      .getSettings()
      .then((s) => setSaveDir(s.torrent.saveDir || ''))
      .catch(() => setSaveDir(''))
    const un = api().onDownloadsChanged((items) => {
      const fresh = items.find((d) => d.id === item.id)
      if (fresh) setLive(fresh)
    })
    return un
  }, [item.id])

  // .torrent içeriğini çöz: onay penceresinde dosya adı/boyutu gerçek olsun.
  useEffect(() => {
    let alive = true
    setReading(true)
    setMeta(null)
    void api()
      .inspectTorrent(item.savePath)
      .then((res) => {
        if (alive) setMeta(res)
      })
      .catch(() => {
        if (alive) setMeta({ ok: false })
      })
      .finally(() => {
        if (alive) setReading(false)
      })
    return () => {
      alive = false
    }
  }, [item.savePath])

  // Hedef: torrent ayarlarındaki klasör; yoksa .torrent dosyasının klasörü.
  const folder = saveDir || (live.savePath ? dirname(live.savePath) : '')
  const files = meta?.ok ? meta.files ?? [] : []
  const contentName = meta?.ok && meta.name ? meta.name : live.name
  const preview = 8

  async function start(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onDecide()
    } catch (e: any) {
      setError(e?.message || t('confirm.torrent.error'))
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-label={t('confirm.torrent.title')}>
        <div className="d-head">
          <span className="brand-mark" style={{ width: 30, height: 30, fontSize: 17 }}>
            🧲
          </span>
          <div>
            <h2>{t('confirm.torrent.title')}</h2>
            <div className="sub">
              {t('confirm.from')}: {hostOf(live.url)}
            </div>
          </div>
        </div>

        <div className="d-body" style={{ gap: 10 }}>
          <div className="confirm-icon">⬧</div>
          <p className="confirm-q">{t('confirm.torrent.question')}</p>
          <p className="confirm-name">
            <b>{contentName}</b>
          </p>

          <dl className="info-grid">
            <dt>{t('col.size')}</dt>
            <dd>
              {reading
                ? t('confirm.torrent.reading')
                : meta?.ok && (meta.totalBytes ?? 0) > 0
                  ? formatBytes(meta.totalBytes!)
                  : t('add.sizeUnknown')}
            </dd>
            <dt>{t('confirm.torrent.fileCount')}</dt>
            <dd>
              {reading
                ? '—'
                : meta?.ok
                  ? t('confirm.torrent.files', { n: files.length })
                  : '—'}
            </dd>
            <dt>{t('add.saveTo')}</dt>
            <dd style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{folder}</dd>
          </dl>

          {files.length > 0 && (
            <div
              style={{
                maxHeight: 132,
                overflow: 'auto',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '6px 8px',
                fontSize: 11.5
              }}
            >
              {files.slice(0, preview).map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={f.name}
                  >
                    {f.name}
                  </span>
                  <span className="muted" style={{ flex: '0 0 auto' }}>
                    {formatBytes(f.length)}
                  </span>
                </div>
              ))}
              {files.length > preview && (
                <div className="muted">
                  {t('confirm.torrent.moreFiles', { n: files.length - preview })}
                </div>
              )}
            </div>
          )}

          {!reading && meta && !meta.ok && (
            <div className="muted" style={{ fontSize: 11.5, textAlign: 'center' }}>
              {t('confirm.torrent.unreadable')}
            </div>
          )}

          <div className="muted" style={{ fontSize: 11.5, textAlign: 'center' }}>
            {t('confirm.torrent.hint')}
          </div>

          {error && (
            <div
              className="card"
              style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
            >
              <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
            </div>
          )}
        </div>

        <div className="d-foot" style={{ justifyContent: 'center', gap: 12 }}>
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t('confirm.torrent.later')}
          </button>
          <button className="btn primary" onClick={() => void start()} disabled={busy}>
            {busy ? <span className="spin" /> : '⬇'} {t('confirm.torrent.download')}
          </button>
        </div>
      </div>
    </div>
  )
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return u.slice(0, 50)
  }
}
