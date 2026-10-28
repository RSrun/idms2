import { useEffect, useState, type CSSProperties } from 'react'
import type { DownloadItem, DownloadState } from '@shared/types'
import { useT, getLang } from '../i18n'
import {
  formatBytes,
  formatDateTime,
  formatEta,
  formatRelative,
  formatSpeed,
  iconFor,
  percentText
} from '../format'
import type { I18nKey } from '@shared/i18n'

type Action = 'start' | 'pause' | 'remove' | 'open' | 'copy' | 'showFolder' | 'queue'

interface Props {
  items: DownloadItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAction: (id: string, action: Action) => void
}

/** Sol tıkla açılan dosya ayrıntıları penceresi */
interface DetailsState {
  id: string
  /** Satırın o anki konumu (pencere satıra göre hizalanır) */
  rect: DOMRect
}

/** Sağ tık menüsü */
interface MenuState {
  id: string
  x: number
  y: number
}

const STATE_KEY: Record<DownloadState, I18nKey> = {
  queued: 'state.queued',
  resolving: 'state.resolving',
  confirming: 'state.confirming',
  downloading: 'state.downloading',
  paused: 'state.paused',
  completed: 'state.completed',
  error: 'state.error',
  canceled: 'state.canceled',
  scheduled: 'state.scheduled'
}

const CAT_KEY: Record<string, I18nKey> = {
  video: 'cat.video',
  audio: 'cat.audio',
  archive: 'cat.archive',
  program: 'cat.program',
  document: 'cat.document',
  other: 'cat.other'
}

/** "Kuyruğa ekle" etkin olabilecek durumlar */
const QUEUEABLE: DownloadState[] = [
  'downloading',
  'resolving',
  'paused',
  'error',
  'canceled',
  'scheduled'
]

export function DownloadList({ items, selectedId, onSelect, onAction }: Props) {
  const t = useT()
  const [details, setDetails] = useState<DetailsState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Açık pencere menüyü/işaretçiyi kapat: dışarı tıkla, Esc, kaydırma, boyut
  useEffect(() => {
    if (!details && !menu) return
    const close = () => {
      setDetails(null)
      setMenu(null)
    }
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('.details-card') || el?.closest('.ctx-menu')) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onScroll = () => close()
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [details, menu])

  const openDetails = (id: string, rect: DOMRect) => {
    setMenu(null)
    setDetails((d) => (d && d.id === id ? null : { id, rect }))
  }
  const openMenu = (id: string, x: number, y: number) => {
    setDetails(null)
    setMenu({ id, x, y })
  }

  const detailsItem = details ? items.find((i) => i.id === details.id) : undefined
  const menuItem = menu ? items.find((i) => i.id === menu.id) : undefined

  if (items.length === 0) {
    return (
      <div className="list-wrap">
        <div className="empty">
          <div className="big">⤓</div>
          <h3>{t('empty.title')}</h3>
          <p>{t('empty.hint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="list-wrap">
      <table className="dl">
        <thead>
          <tr>
            <th style={{ width: '38%' }}>{t('col.name')}</th>
            <th style={{ width: 92 }}>{t('col.size')}</th>
            <th style={{ width: 92 }}>{t('col.speed')}</th>
            <th style={{ width: 96 }}>{t('col.eta')}</th>
            <th style={{ width: 150 }}>{t('col.progress')}</th>
            <th style={{ width: 130 }}>{t('col.status')}</th>
            <th style={{ width: 105 }}>{t('col.added')}</th>
            <th style={{ width: 250 }} />
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <Row
              key={d.id}
              item={d}
              selected={selectedId === d.id}
              onSelect={onSelect}
              onAction={onAction}
              onDetails={openDetails}
              onMenu={openMenu}
            />
          ))}
        </tbody>
      </table>

      {details && detailsItem && (
        <DetailsCard
          item={detailsItem}
          rect={details.rect}
          onAction={onAction}
          onClose={() => setDetails(null)}
        />
      )}
      {menu && menuItem && (
        <ContextMenu
          item={menuItem}
          x={menu.x}
          y={menu.y}
          onAction={(id, action) => {
            setMenu(null)
            onAction(id, action)
          }}
        />
      )}
    </div>
  )
}

function Row({
  item,
  selected,
  onSelect,
  onAction,
  onDetails,
  onMenu
}: {
  item: DownloadItem
  selected: boolean
  onSelect: (id: string | null) => void
  onAction: (id: string, action: Action) => void
  onDetails: (id: string, rect: DOMRect) => void
  onMenu: (id: string, x: number, y: number) => void
}) {
  const t = useT()
  const lang = getLang()
  const pct = Math.round(item.progress.percent * 100)
  const active = item.state === 'downloading'
  const done = item.state === 'completed'
  const failed = item.state === 'error'

  const canPause = active || item.state === 'queued' || item.state === 'resolving'
  const canStart =
    item.state === 'paused' ||
    item.state === 'error' ||
    item.state === 'canceled' ||
    item.state === 'queued'

  return (
    <tr
      className={selected ? 'selected' : ''}
      onClick={(e) => {
        onSelect(selected ? null : item.id)
        onDetails(item.id, e.currentTarget.getBoundingClientRect())
      }}
      onDoubleClick={() => {
        if (done) onAction(item.id, 'open')
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect(item.id)
        onMenu(item.id, e.clientX, e.clientY)
      }}
      title={item.url}
    >
      <td>
        <div className="cell-name">
          <span className={`fico ${iconFor(item.name, item.kind)}`}>
            {iconGlyph(item)}
          </span>
          <div className="txt">
            <div className="nm">{item.name}</div>
            <div className="sub">
              {hostOf(item.url)}
              {item.media?.statusLine ? ` · ${item.media.statusLine}` : ''}
              {item.errorMessage ? ` · ${item.errorMessage}` : ''}
            </div>
          </div>
        </div>
      </td>
      <td className="num">
        {item.progress.totalBytes > 0 ? formatBytes(item.progress.totalBytes) : '—'}
      </td>
      <td className="num">{active ? formatSpeed(item.progress.speed) : '—'}</td>
      <td className="num">
        {active
          ? formatEta(item.progress.etaSeconds)
          : item.state === 'scheduled' && item.scheduledAt
            ? new Date(item.scheduledAt).toLocaleTimeString(lang === 'tr' ? 'tr-TR' : 'en-GB', {
                hour: '2-digit',
                minute: '2-digit'
              })
            : '—'}
      </td>
      <td>
        <ProgressBar item={item} pct={pct} />
      </td>
      <td>
        <StatusPill state={item.state} label={t(STATE_KEY[item.state])} />
      </td>
      <td className="num" style={{ fontSize: 11.5 }}>
        {formatRelative(item.createdAt)}
      </td>
      <td>
        <div className="row-actions">
          {canStart && (
            <button
              className="iconbtn"
              title={t('toolbar.start')}
              onClick={(e) => {
                e.stopPropagation()
                onAction(item.id, 'start')
              }}
            >
              ▶
            </button>
          )}
          {canPause && (
            <button
              className="iconbtn"
              title={t('toolbar.pause')}
              onClick={(e) => {
                e.stopPropagation()
                onAction(item.id, 'pause')
              }}
            >
              ⏸
            </button>
          )}
          {done && (
            <button
              className="iconbtn"
              title={t('action.showInFolder')}
              onClick={(e) => {
                e.stopPropagation()
                onAction(item.id, 'showFolder')
              }}
            >
              📁
            </button>
          )}
          <button
            className="iconbtn"
            title={t('action.copyUrl')}
            onClick={(e) => {
              e.stopPropagation()
              onAction(item.id, 'copy')
            }}
          >
            🔗
          </button>
          <button
            className="iconbtn danger"
            title={t('toolbar.remove')}
            onClick={(e) => {
              e.stopPropagation()
              onAction(item.id, 'remove')
            }}
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  )
}

/* ------------------------------------------------------------------ */
/* Sol tık: dosya ayrıntıları penceresi                                */
/* ------------------------------------------------------------------ */

function DetailsCard({
  item,
  rect,
  onAction,
  onClose
}: {
  item: DownloadItem
  rect: DOMRect
  onAction: (id: string, action: Action) => void
  onClose: () => void
}) {
  const t = useT()
  const lang = getLang()
  const [copied, setCopied] = useState(false)

  const p = item.progress
  const done = item.state === 'completed'
  const total = p.totalBytes > 0 ? formatBytes(p.totalBytes) : '—'

  // Satıra hizala; altta yer yoksa yukarı açılır, sağ kenardan taşmaz
  const width = 368
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  const spaceBelow = window.innerHeight - rect.bottom
  const openUp = spaceBelow < 300 && rect.top > spaceBelow
  const style: CSSProperties = openUp
    ? { left, bottom: window.innerHeight - rect.top + 6 }
    : { left, top: rect.bottom + 6 }

  const copyUrl = () => {
    void navigator.clipboard.writeText(item.url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="details-card" style={style} role="dialog" aria-label={t('detail.title')}>
      <div className="dhead">
        <span className={`fico ${iconFor(item.name, item.kind)}`}>{iconGlyph(item)}</span>
        <div className="dtxt">
          <div className="nm">{item.name}</div>
          <div className="sub">{t('detail.title')}</div>
        </div>
        <StatusPill state={item.state} label={t(STATE_KEY[item.state])} />
      </div>

      <div className="dgrid">
        <DRow k={t('col.category')} v={t(CAT_KEY[item.category] ?? 'cat.other')} />
        <DRow
          k={t('col.size')}
          v={`${total} · ${formatBytes(p.downloadedBytes)} (${percentText(p.percent)})`}
        />
        <DRow k={t('col.speed')} v={p.speed > 0 ? formatSpeed(p.speed) : '—'} />
        <DRow k={t('col.eta')} v={p.etaSeconds != null ? formatEta(p.etaSeconds) : '—'} />
        <DRow
          k={t('detail.connections')}
          v={item.kind === 'torrent' ? String(item.torrent?.peers ?? 0) : String(p.connections)}
        />
        {item.kind === 'torrent' && (
          <DRow k={t('detail.torrentRatio')} v={(item.torrent?.ratio ?? 0).toFixed(2)} />
        )}
        <DRow k={t('col.added')} v={formatDateTime(item.createdAt, lang)} />
        <div className="drow">
          <span className="dk">{t('add.url')}</span>
          <span className="dv mono">
            {item.url}
            <button
              className="dmini"
              title={copied ? t('common.copied') : t('action.copyUrl')}
              onClick={copyUrl}
            >
              {copied ? '✓' : '⧉'}
            </button>
          </span>
        </div>
        <div className="drow">
          <span className="dk">{t('add.saveTo')}</span>
          <span className="dv mono">
            {item.savePath}
            <button
              className="dmini"
              title={t('action.showInFolder')}
              onClick={() => onAction(item.id, 'showFolder')}
            >
              📁
            </button>
          </span>
        </div>
        {item.errorMessage && (
          <div className="drow">
            <span className="dk">{t('common.error')}</span>
            <span className="dv err">{item.errorMessage}</span>
          </div>
        )}
      </div>

      <div className="dfbtns">
        <button
          className="btn primary"
          disabled={!done}
          onClick={() => onAction(item.id, 'open')}
        >
          {t('action.openFile')}
        </button>
        <button className="btn" onClick={() => onAction(item.id, 'showFolder')}>
          {t('action.showInFolder')}
        </button>
        <button className="btn ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  )
}

function DRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="drow">
      <span className="dk">{k}</span>
      <span className="dv">{v}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sağ tık: bağlam menüsü                                             */
/* ------------------------------------------------------------------ */

function ContextMenu({
  item,
  x,
  y,
  onAction
}: {
  item: DownloadItem
  x: number
  y: number
  onAction: (id: string, action: Action) => void
}) {
  const t = useT()
  const done = item.state === 'completed'
  const canQueue = QUEUEABLE.includes(item.state)

  // Görünür alanda tut (menü ~200px yükseklik, ~200px genişlik)
  const left = Math.max(8, Math.min(x, window.innerWidth - 210))
  const top = Math.max(8, Math.min(y, window.innerHeight - 210))

  return (
    <div className="ctx-menu" style={{ left, top }} role="menu">
      <button
        className="ctx-item"
        disabled={!done}
        role="menuitem"
        onClick={() => onAction(item.id, 'open')}
      >
        <span className="ico">📂</span>
        {t('action.openFile')}
      </button>
      <button
        className="ctx-item"
        role="menuitem"
        onClick={() => onAction(item.id, 'showFolder')}
      >
        <span className="ico">🗂</span>
        {t('action.showInFolder')}
      </button>
      <div className="ctx-sep" />
      <button
        className="ctx-item"
        disabled={!canQueue}
        role="menuitem"
        onClick={() => onAction(item.id, 'queue')}
      >
        <span className="ico">⏬</span>
        {t('action.queue')}
      </button>
      <div className="ctx-sep" />
      <button
        className="ctx-item danger"
        role="menuitem"
        onClick={() => onAction(item.id, 'remove')}
      >
        <span className="ico">🗑</span>
        {t('toolbar.remove')}
      </button>
    </div>
  )
}

function ProgressBar({ item, pct }: { item: DownloadItem; pct: number }) {
  const t = useT()
  const cls = item.state === 'completed' ? 'done' : item.state === 'error' ? 'error' : ''
  const indeterminate = item.state === 'resolving' || item.state === 'queued'
  const label = indeterminate && item.progress.totalBytes === 0 ? '…' : percentText(item.progress.percent)
  return (
    <div className={`pbar ${cls}`} title={t('col.progress')}>
      <div
        className="fill"
        style={{ width: `${Math.max(2, pct)}%`, opacity: indeterminate ? 0.5 : 1 }}
      />
      <span className={`lbl ${pct > 40 ? 'light' : ''}`}>{label}</span>
    </div>
  )
}

export function StatusPill({ state, label }: { state: DownloadState; label: string }) {
  return (
    <span className={`pill ${state}`}>
      <span className="dot" />
      {label}
    </span>
  )
}

function iconGlyph(item: DownloadItem): string {
  if (item.kind === 'torrent') return '🧲'
  const cls = iconFor(item.name, item.kind)
  switch (cls) {
    case 'video':
      return '▶'
    case 'audio':
      return '♪'
    case 'archive':
      return '🗜'
    case 'program':
      return '⚙'
    case 'document':
      return '≡'
    default:
      return '⬓'
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return u.slice(0, 40)
  }
}
