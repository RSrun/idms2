import './float.css'
import { formatBytes } from './format'
import type {
  FloatAction,
  FloatFormat,
  FloatFormatsState,
  FloatMediaInfo,
  FloatPanelState
} from '@shared/types'

/**
 * Yüzen IDMS paneli: video/ses oynarken görünen küçük rozet. Rozete
 * tıklayınca IDM'nin yüzen paneli gibi video kaliteleri ve ses dosyaları
 * listelenir. Pencere main süreç tarafından medyanın sağ üst köşesine
 * yerleştirilir; burada yalnızca görünüm ve eylemler yönetilir.
 */

const api = window.idms2.float

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const floatEl = $('float')
const pill = $<HTMLButtonElement>('pill')
const card = $('card')
const titleEl = $('title')
const metaEl = $('meta')
const statusEl = $('status')
const listEl = $('list')
const footEl = document.querySelector('.foot') as HTMLElement

const LANG: Record<'tr' | 'en', Record<string, string>> = {
  tr: {
    videoSec: 'Video',
    audioSec: 'Ses',
    loading: 'Kaliteler alınıyor…',
    noFormats: 'Kalite listesi yok',
    origVideo: 'Özgün video',
    origAudio: 'Özgün ses',
    audioMp3: 'Sadece ses (MP3)',
    best: 'en iyi',
    formats: 'Formatlar…',
    open: "IDMS'i aç",
    close: 'Kapat',
    videoKind: 'Video',
    audioKind: 'Ses',
    unsupported: 'Bu adres doğrudan indirilemiyor'
  },
  en: {
    videoSec: 'Video',
    audioSec: 'Audio',
    loading: 'Reading qualities…',
    noFormats: 'No quality list',
    origVideo: 'Original video',
    origAudio: 'Original audio',
    audioMp3: 'Audio only (MP3)',
    best: 'best',
    formats: 'Formats…',
    open: 'Open IDMS',
    close: 'Close',
    videoKind: 'Video',
    audioKind: 'Audio',
    unsupported: 'This address cannot be downloaded directly'
  }
}

let media: FloatMediaInfo | null = null
let formats: FloatFormat[] = []
let formatsState: FloatFormatsState = 'idle'
let formatsNote = ''
let lang: 'tr' | 'en' = 'tr'
let expanded = false
let statusTimer = 0
let busy = false

function t(key: string): string {
  return (LANG[lang] && LANG[lang][key]) || LANG.tr[key] || key
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function duration(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rs = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`
    : `${m}:${String(rs).padStart(2, '0')}`
}

function formatLabel(f: FloatFormat): string {
  if (f.labelKey) return t(f.labelKey)
  return f.label || 'Video'
}

function render(): void {
  if (!media) {
    floatEl.hidden = true
    return
  }
  floatEl.hidden = false

  const labels = LANG[lang]
  $('formats').textContent = labels.formats
  $('open').textContent = labels.open
  $('close').title = labels.close
  $('close').setAttribute('aria-label', labels.close)

  titleEl.textContent = media.title || media.pageTitle || hostOf(media.pageUrl) || 'IDMS'
  const bits: string[] = []
  const host = hostOf(media.pageUrl || media.url)
  if (host) bits.push(host)
  bits.push(media.kind === 'audio' ? labels.audioKind : labels.videoKind)
  const d = duration(media.duration)
  if (d) bits.push(d)
  metaEl.textContent = bits.join(' · ')

  renderList()
  applyExpanded(expanded, true)
}

function noteRow(text: string, spinner: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = `note${spinner ? ' busy' : ''}`
  if (spinner) {
    const spin = document.createElement('span')
    spin.className = 'spin'
    row.appendChild(spin)
  }
  const label = document.createElement('span')
  label.className = 'note-text'
  label.textContent = text
  row.appendChild(label)
  return row
}

function formatRow(f: FloatFormat): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = `row${f.best ? ' best' : ''}`
  row.dataset.formatId = f.formatId
  const label = formatLabel(f)
  row.title = [label, f.detail, f.sizeBytes ? formatBytes(f.sizeBytes) : '']
    .filter(Boolean)
    .join(' · ')

  const q = document.createElement('span')
  q.className = 'q'
  q.textContent = label
  row.appendChild(q)

  if (f.detail) {
    const detail = document.createElement('span')
    detail.className = 'detail'
    detail.textContent = f.detail
    row.appendChild(detail)
  }
  if (typeof f.sizeBytes === 'number' && f.sizeBytes > 0) {
    const size = document.createElement('span')
    size.className = 'size'
    size.textContent = formatBytes(f.sizeBytes)
    row.appendChild(size)
  }
  return row
}

function renderList(): void {
  listEl.textContent = ''

  if (formatsState === 'loading' || formatsState === 'idle') {
    listEl.appendChild(noteRow(t('loading'), true))
    return
  }
  if (formatsState === 'error' || formatsState === 'empty' || formats.length === 0) {
    listEl.appendChild(noteRow(formatsNote || t('noFormats'), false))
    return
  }

  for (const kind of ['video', 'audio'] as const) {
    const rows = formats.filter((f) => f.kind === kind)
    if (rows.length === 0) continue
    const sec = document.createElement('div')
    sec.className = 'sec'
    sec.textContent = kind === 'video' ? t('videoSec') : t('audioSec')
    const count = document.createElement('span')
    count.className = 'sec-count'
    count.textContent = String(rows.length)
    sec.appendChild(count)
    listEl.appendChild(sec)
    for (const f of rows) listEl.appendChild(formatRow(f))
  }
}

function applyExpanded(next: boolean, silent = false): void {
  expanded = next
  floatEl.classList.toggle('expanded', expanded)
  card.hidden = !expanded
  pill.hidden = expanded
  if (!silent) {
    void api.action({ type: expanded ? 'expand' : 'collapse' } as FloatAction)
  }
}

function showStatus(message: string, tone: 'info' | 'error' | 'success' = 'info'): void {
  if (!message) return
  window.clearTimeout(statusTimer)
  statusEl.textContent = message
  statusEl.className = `status ${tone}`
  statusEl.hidden = false
  footEl.style.display = 'none'
  statusTimer = window.setTimeout(() => {
    statusEl.hidden = true
    footEl.style.display = ''
  }, 6000)
}

async function send(action: FloatAction, button?: HTMLButtonElement | null): Promise<void> {
  if (busy) return
  busy = true
  if (button) button.disabled = true
  try {
    const res = await api.action(action)
    if (!res?.ok) showStatus(res?.message || t('unsupported'), 'error')
    else if (res.message) showStatus(res.message, 'success')
  } catch (err: any) {
    showStatus(String(err?.message || err), 'error')
  } finally {
    busy = false
    if (button) button.disabled = false
  }
}

/* ---- açılır/kapanır (tıklayınca) ---- */

// Rozete tıklamak kartı açar; üzerine gelmek açmaz.
pill.addEventListener('click', () => {
  if (media) applyExpanded(true)
})

// Başlık alanına tıklamak kartı yeniden rozete küçültür.
const headEl = document.querySelector('.head')
headEl?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null
  if (target?.closest('#close')) return
  if (expanded) applyExpanded(false)
})

$('close').addEventListener('click', (e) => {
  e.stopPropagation()
  void api.action({ type: 'close' })
})

listEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null
  const row = target?.closest<HTMLButtonElement>('.row')
  if (!row || row.disabled) return
  const formatId = row.dataset.formatId
  if (!formatId) return
  void send({ type: 'download-format', formatId }, row)
})

$('formats').addEventListener('click', () => void api.action({ type: 'formats' }))
$('open').addEventListener('click', () => void api.action({ type: 'open-app' }))

/* ---- main süreçten gelen durum ---- */

function applyState(state: FloatPanelState): void {
  media = state.media
  formats = Array.isArray(state.formats) ? state.formats : []
  formatsState = state.formatsState || 'idle'
  formatsNote = state.formatsNote || ''
  lang = state.language === 'en' ? 'en' : 'tr'
  document.documentElement.lang = lang
  applyExpanded(!!state.expanded, true)
  render()
}

api.onMedia(applyState)

api.onStatus(({ message, tone }) => showStatus(message, tone))

void api.state().then((state) => {
  if (state) applyState(state)
})

// Panel boşken tıklamaları yutmayalım
document.addEventListener('contextmenu', (e) => e.preventDefault())
