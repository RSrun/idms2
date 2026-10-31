import { useEffect, useState } from 'react'
import { useT } from '../i18n'

const api = () => window.idms2

interface Props {
  onClose: () => void
  onAdded: (id: string) => void
}

/** Torrent ekleme penceresi: magnet bağlantısı veya .torrent dosyası. */
export function TorrentDialog({ onClose, onAdded }: Props) {
  const t = useT()
  const [input, setInput] = useState('')
  const [saveDir, setSaveDir] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api()
      .getSettings()
      .then((s) => setSaveDir(s.torrent.saveDir))
    // Magnet ile açılma durumunda pencere URL'den beslenebilir
    const params = new URLSearchParams(window.location.search)
    const m = params.get('magnet')
    if (m) setInput(m)
  }, [])

  async function submit(): Promise<void> {
    const v = input.trim()
    if (!v) {
      setError(t('torrent.invalid'))
      return
    }
    if (!/^magnet:\?/i.test(v) && !/\.torrent$/i.test(v) && !/^https?:\/\//i.test(v)) {
      setError(t('torrent.invalid'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await api().addTorrent({ magnetOrPath: v, saveDir: saveDir || undefined })
      onAdded(res.id)
      if (res.duplicate) {
        // Hata değil: aynı torrent ikinci kez eklendi, mevcut kayıt seçildi
        setNotice(t('torrent.duplicate'))
        return
      }
      onClose()
    } catch (e: any) {
      setError(e?.message || t('torrent.invalid'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={t('torrent.title')}>
        <div className="d-head">
          <span className="brand-mark" style={{ width: 30, height: 30, fontSize: 17 }}>
            🧲
          </span>
          <div>
            <h2>{t('torrent.title')}</h2>
            <div className="sub">webtorrent · DHT · µTP</div>
          </div>
          <button className="d-close" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        <div className="d-body">
          <div className="field">
            <label>{t('torrent.magnet')}</label>
            <div className="row">
              <input
                className="input"
                placeholder="magnet:?xt=urn:btih:..."
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  setNotice('')
                }}
                spellCheck={false}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              <button
                className="btn"
                onClick={async () => {
                  const f = await api().pickTorrentFile()
                  if (f) setInput(f)
                }}
              >
                {t('torrent.pick')}
              </button>
            </div>
          </div>

          <div className="field">
            <label>{t('torrent.saveTo')}</label>
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

          {error && (
            <div
              className="card"
              style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
            >
              <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
            </div>
          )}

          {notice && (
            <div className="card">
              <p style={{ margin: 0 }}>{notice}</p>
            </div>
          )}

          <div className="card">
            <h4>ℹ️ {t('settings.tab.about')}</h4>
            <p>{t('torrent.dhtDisabled')}</p>
          </div>
        </div>

        <div className="d-foot">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={busy || !input.trim()}
            onClick={() => void submit()}
          >
            {busy ? <span className="spin" /> : '🧲'} {t('torrent.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
