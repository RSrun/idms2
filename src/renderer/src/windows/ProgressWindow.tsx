import { useEffect, useMemo, useState } from 'react'
import type { DownloadItem, DownloadWindowSegment, Settings } from '@shared/types'
import { useT } from '../i18n'
import { formatBytes, formatEta, formatSpeed } from '../format'
import { segmentTone } from './shared'

interface Props {
  item: DownloadItem
  segments: DownloadWindowSegment[]
  settings: Settings
}

type Tab = 'status' | 'limiter' | 'after'

/** IDM'nin indirme sırasındaki ilerleme penceresi. */
export function ProgressWindow({ item, segments, settings }: Props) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('status')
  const [details, setDetails] = useState(true)
  const [limit, setLimit] = useState(String(settings.general.speedLimitMbps))

  useEffect(() => {
    setLimit(String(settings.general.speedLimitMbps))
  }, [settings.general.speedLimitMbps])

  useEffect(() => {
    const pct = Math.round(item.progress.percent * 100)
    document.title = `${pct}% ${item.name}`
  }, [item.progress.percent, item.name])

  const status = useMemo(() => t(statusText(item) as any), [item, t])
  const pauseable =
    item.state === 'downloading' || item.state === 'queued' || item.state === 'resolving'
  const percent = Math.round(item.progress.percent * 100)
  const total = item.progress.totalBytes

  return (
    <div className="dlwin progwin">
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'status'}
          className={`tab ${tab === 'status' ? 'active' : ''}`}
          onClick={() => setTab('status')}
        >
          {t('win.progress.tabStatus')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'limiter'}
          className={`tab ${tab === 'limiter' ? 'active' : ''}`}
          onClick={() => setTab('limiter')}
        >
          {t('win.progress.tabLimiter')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'after'}
          className={`tab ${tab === 'after' ? 'active' : ''}`}
          onClick={() => setTab('after')}
        >
          {t('win.progress.tabAfter')}
        </button>
      </div>

      {tab === 'status' && (
        <>
          <div className="group status-group">
            <div className="url-line" title={item.url}>
              {item.url}
            </div>
            <div className="kv">
              <span className="k">{t('win.progress.status')}:</span>
              <span className="v">{status}</span>
            </div>
            <div className="kv">
              <span className="k">{t('win.progress.size')}:</span>
              <span className="v">{total > 0 ? formatBytes(total) : '—'}</span>
            </div>
            <div className="kv">
              <span className="k">{t('win.progress.downloaded')}:</span>
              <span className="v">
                {formatBytes(item.progress.downloadedBytes)} ({percent} %)
              </span>
            </div>
            <div className="kv">
              <span className="k">{t('win.progress.speed')}:</span>
              <span className="v">{formatSpeed(item.progress.speed)}</span>
            </div>
            <div className="kv">
              <span className="k">{t('win.progress.eta')}:</span>
              <span className="v">
                {item.progress.etaSeconds !== null
                  ? formatEta(item.progress.etaSeconds)
                  : '—'}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t('win.progress.resume')}:</span>
              <span className="v">
                {item.supportsRange === undefined
                  ? '—'
                  : item.supportsRange
                    ? t('common.yes')
                    : t('common.no')}
              </span>
            </div>
          </div>

          <div className="bar" aria-label={`${percent}%`}>
            <div className="bar-fill" style={{ width: `${percent}%` }} />
          </div>

          <div className="prog-actions">
            <button type="button" className="btn" onClick={() => setDetails((v) => !v)}>
              {details ? t('win.progress.detailsHide') : t('win.progress.detailsShow')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void window.dlwin.action({
                  type: pauseable ? 'progress-pause' : 'progress-resume'
                })
              }
            >
              {pauseable ? t('win.progress.pause') : t('win.progress.resumeBtn')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void window.dlwin.action({ type: 'progress-cancel' })}
            >
              {t('win.progress.cancel')}
            </button>
          </div>

          {details && (
            <>
              <div className="conn-title">{t('win.progress.connHead')}</div>
              {segments.length > 0 ? (
                <>
                  <div className="conn-strip">
                    {segments.map((s) => {
                      const fill = s.size > 0 ? Math.min(1, s.received / s.size) : s.done ? 1 : 0
                      return (
                        <div
                          key={s.index}
                          className={`seg ${segmentTone(s)}`}
                          style={{ flexGrow: Math.max(1, s.size) }}
                          title={`${s.index + 1}: ${formatBytes(s.received)} / ${formatBytes(s.size)}`}
                        >
                          <span style={{ width: `${fill * 100}%` }} />
                        </div>
                      )
                    })}
                  </div>

                  <div className="seg-table">
                    <div className="seg-head">
                      <span>{t('win.progress.tableNo')}</span>
                      <span>{t('win.progress.tableReceived')}</span>
                      <span>{t('win.progress.tableInfo')}</span>
                    </div>
                    <div className="seg-rows">
                      {segments.map((s) => (
                        <div className="seg-row" key={s.index}>
                          <span>{s.index + 1}</span>
                          <span>{formatBytes(s.received)}</span>
                          <span className="seg-info">{segmentInfo(s, item, t)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="muted note">{t('win.progress.noSegments')}</div>
              )}
            </>
          )}
        </>
      )}

      {tab === 'limiter' && (
        <div className="group settings-group">
          <label className="limiter-row">
            <span>{t('win.progress.limitLabel')}</span>
            <input
              className="text number"
              type="number"
              min={0}
              step={0.5}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              onBlur={() => {
                const mbps = Math.max(0, Number(limit) || 0)
                void window.dlwin.action({ type: 'set-speed-limit', mbps })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const mbps = Math.max(0, Number(limit) || 0)
                  void window.dlwin.action({ type: 'set-speed-limit', mbps })
                }
              }}
            />
          </label>
          <div className="muted note">{t('win.progress.limitHint')}</div>
        </div>
      )}

      {tab === 'after' && (
        <div className="group settings-group">
          <label className="check block">
            <input
              type="checkbox"
              checked={settings.notifications.completeWindow !== false}
              onChange={(e) =>
                void window.idms2.patchSettings({
                  notifications: { completeWindow: e.target.checked }
                })
              }
            />
            {t('win.progress.afterCompleteWindow')}
          </label>
          <label className="check block">
            <input
              type="checkbox"
              checked={settings.notifications.onComplete}
              onChange={(e) =>
                void window.idms2.patchSettings({
                  notifications: { onComplete: e.target.checked }
                })
              }
            />
            {t('win.progress.afterNotification')}
          </label>
          <div className="muted note">{t('win.progress.afterHint')}</div>
        </div>
      )}
    </div>
  )
}

function statusText(item: DownloadItem): string {
  if (item.state === 'downloading') {
    return item.media?.statusLine || 'win.progress.receiving'
  }
  const map: Record<string, string> = {
    queued: 'win.progress.waiting',
    resolving: 'win.progress.connecting',
    paused: 'win.progress.paused',
    canceled: 'win.progress.canceled',
    completed: 'win.progress.done',
    error: 'win.progress.failed',
    scheduled: 'state.scheduled'
  }
  return map[item.state] || item.state
}

function segmentInfo(
  seg: DownloadWindowSegment,
  item: DownloadItem,
  t: (key: any) => string
): string {
  if (seg.done) return t('win.progress.done')
  if (item.state === 'paused') return t('win.progress.paused')
  if (item.state === 'downloading') {
    return seg.received > 0 ? t('win.progress.receiving') : t('win.progress.waiting')
  }
  return t('win.progress.waiting')
}
