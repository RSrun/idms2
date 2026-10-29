import { useEffect, useMemo, useState } from 'react'
import type { MediaFormat, MediaProbeResult } from '@shared/types'
import { useT } from '../i18n'
import { formatBytes } from '../format'

const api = () => window.idms2

interface Props {
  url: string
  pageUrl?: string
  initialTitle?: string
  onClose: () => void
  onDownloaded: (id: string) => void
}

type Tab = 'video' | 'audio'

/**
 * Sosyal medya indirme penceresi: yt-dlp biçim listesini gösterir,
 * kullanıcı kalite/seçer ve indirme başlar.
 */
export function MediaDialog({ url, pageUrl, initialTitle, onClose, onDownloaded }: Props) {
  const t = useT()
  const [probe, setProbe] = useState<MediaProbeResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('video')
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null)
  const [audioFormat, setAudioFormat] = useState<string | null>(null)
  const [startNow, setStartNow] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const res = await api().probeMedia(url, pageUrl)
        if (!alive) return
        setProbe(res)
        if (!res.ok) {
          setError(res.error || t('err.ytdlpMissing'))
        } else {
          // Varsayılanlar: en iyi video, en iyi ses.
          // HLS (m3u8) kopyaları atlanır: ayrı ses akışıyla birleştirilemiyorlar;
          // eşdeğer DASH biçimi varsa o seçilir.
          const video =
            res.formats.find((f) => !f.isAudioOnly && !f.hls && f.vcodec?.includes('vp9')) ||
            res.formats.find((f) => !f.isAudioOnly && !f.hls) ||
            res.formats.find((f) => !f.isAudioOnly)
          const audio =
            res.formats.find((f) => f.isAudioOnly && !f.hls) ||
            res.formats.find((f) => f.isAudioOnly)
          setSelectedFormat(video?.formatId ?? null)
          setAudioFormat(audio?.formatId ?? null)
        }
      } catch (e: any) {
        if (alive) setError(e?.message || t('err.generic'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // HLS (m3u8) kopyaları ayrı ses akışıyla birleştirilemiyor ve boyutları
  // bilinmiyor; eşdeğer DASH (https) biçimi varsa listede gösterilmez.
  // Yalnızca HLS varsa (canlı yayın) hepsi listelenir.
  const visible = useMemo(() => {
    const all = probe?.formats || []
    const videos = all.filter((f) => !f.isAudioOnly)
    const audios = all.filter((f) => f.isAudioOnly)
    const dashVideos = videos.filter((f) => !f.hls)
    const dashAudios = audios.filter((f) => !f.hls)
    return {
      video: dashVideos.length > 0 ? dashVideos : videos,
      audio: dashAudios.length > 0 ? dashAudios : audios
    }
  }, [probe])
  const videoFormats = visible.video
  const audioFormats = visible.audio

  async function start(): Promise<void> {
    try {
      const res = await api().downloadMedia({
        url,
        pageUrl,
        formatId: tab === 'video' ? selectedFormat || undefined : audioFormat || undefined,
        quality: tab === 'audio' ? 'audio' : 'best'
      })
      if (res?.id) onDownloaded(res.id)
      onClose()
    } catch (e: any) {
      setError(e?.message || t('err.generic'))
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide media" role="dialog" aria-label={t('media.title')}>
        <div className="d-head">
          <span className="brand-mark" style={{ width: 30, height: 30, fontSize: 17 }}>
            🎬
          </span>
          <div>
            <h2>{t('media.title')}</h2>
            <div className="sub">{hostOf(url)}</div>
          </div>
          <button className="d-close" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        <div className="d-body">
          <div className="media-head">
            <div className="media-thumb">
              {probe?.thumbnail ? <img src={probe.thumbnail} alt="" /> : '🎬'}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="media-title">{probe?.title || initialTitle || url}</div>
              <div className="media-meta">
                {probe?.extractor && <span className="badge-inline">{probe.extractor}</span>}
                {typeof probe?.durationSeconds === 'number' && (
                  <span className="badge-inline">
                    🕒 {formatDuration(probe.durationSeconds)}
                  </span>
                )}
                <span className="badge-inline accent">{hostOf(url)}</span>
              </div>
            </div>
          </div>

          {loading && (
            <div className="muted" style={{ fontSize: 12.5, textAlign: 'center', padding: 20 }}>
              <span className="spin" /> {t('media.probing')}
            </div>
          )}

          {error && (
            <div
              className="card"
              style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
            >
              <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
              {error.includes('ffmpeg') && (
                <p style={{ color: 'var(--text-2)' }}>{t('media.ffmpegMissing')}</p>
              )}
              <p style={{ color: 'var(--text-3)' }}>{t('set.social.sitesHint')}</p>
            </div>
          )}

          {!loading && probe?.ok && (
            <>
              <div className="seg">
                <button
                  className={tab === 'video' ? 'active' : ''}
                  onClick={() => setTab('video')}
                >
                  🎬 {t('media.best')}
                </button>
                <button
                  className={tab === 'audio' ? 'active' : ''}
                  onClick={() => setTab('audio')}
                >
                  🎵 {t('media.audioOnly')}
                </button>
              </div>

              {tab === 'video' && (
                <FormatTable
                  formats={videoFormats}
                  selected={selectedFormat}
                  onSelect={setSelectedFormat}
                />
              )}
              {tab === 'audio' && (
                <FormatTable
                  formats={audioFormats}
                  selected={audioFormat}
                  onSelect={setAudioFormat}
                  audioOnly
                />
              )}
            </>
          )}

          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="txt">
              <div className="lbl">{t('add.startNow')}</div>
              <div className="hint">{t('set.confirmBeforeHint')}</div>
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
            {probe?.ok
              ? `${videoFormats.length + audioFormats.length} ${t('media.formats').toLowerCase()}`
              : ''}
          </span>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={
              loading ||
              !probe?.ok ||
              (tab === 'video' ? !selectedFormat && videoFormats.length > 0 : !audioFormat && audioFormats.length > 0)
            }
            onClick={() => void start()}
          >
            ⬇ {t('media.download')}
          </button>
        </div>
      </div>
    </div>
  )
}

function FormatTable({
  formats,
  selected,
  onSelect,
  audioOnly
}: {
  formats: MediaFormat[]
  selected: string | null
  onSelect: (id: string) => void
  audioOnly?: boolean
}) {
  const t = useT()
  if (formats.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12.5, textAlign: 'center', padding: 18 }}>
        {t('media.noFormats')}
      </div>
    )
  }
  return (
    <div className="ftable">
      <div className="frow fhead">
        <span />
        <span>{audioOnly ? t('media.type') : t('media.quality')}</span>
        <span>{t('media.resolution')}</span>
        <span>{t('media.size')}</span>
        <span>{t('common.bytes')}</span>
      </div>
      {formats.map((f) => (
        <div
          key={f.formatId}
          className={`frow ${selected === f.formatId ? 'sel' : ''}`}
          onClick={() => onSelect(f.formatId)}
        >
          <span className="radio" />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <b>{f.ext.toUpperCase()}</b>
            {f.note ? <span className="muted"> · {f.note}</span> : null}
          </span>
          <span className="mono">{f.resolution || (f.isAudioOnly ? '—' : '?')}</span>
          <span className="mono">{f.sizeBytes ? formatBytes(f.sizeBytes) : '—'}</span>
          <span className="mono muted">{f.tbr ? `${Math.round(f.tbr)}k` : ''}</span>
        </div>
      ))}
    </div>
  )
}

function formatDuration(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rs = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`
  return `${m}:${String(rs).padStart(2, '0')}`
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return u.slice(0, 50)
  }
}
