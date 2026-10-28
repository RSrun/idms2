import type { Lang } from '@shared/i18n'

/** Bayt → "1.2 GB" */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  const digits = u === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2
  return `${v.toFixed(digits)} ${units[u]}`
}

export function formatSpeed(bytesPerSec: number | null | undefined): string {
  if (!bytesPerSec || !isFinite(bytesPerSec)) return '—'
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs > 0 ? `${m} dk ${rs}s` : `${m} dk`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm > 0 ? `${h} sa ${rm} dk` : `${h} sa`
  const d = Math.floor(h / 24)
  return `${d} gün ${h % 24} sa`
}

/** "2 dk önce" gibi göreli zaman */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts) / 1000
  if (diff < 60) return 'şimdi'
  if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`
  return new Date(ts).toLocaleDateString()
}

export function formatDateTime(ts: number, lang: Lang = 'tr'): string {
  return new Date(ts).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** İlerleme çubuğu için yüzde metni */
export function percentText(p: number): string {
  if (!isFinite(p)) return '—'
  return `%${Math.round(Math.min(1, Math.max(0, p)) * 100)}`
}

/** Dosya adından ikon sınıfı (basit görsel ayrım) */
export function iconFor(name: string, kind: string): string {
  if (kind === 'torrent') return 'torrent'
  if (kind === 'media') return 'video'
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['mp4', 'mkv', 'avi', 'webm', 'mov', 'flv', 'wmv', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) return 'audio'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) return 'archive'
  if (['exe', 'msi', 'apk', 'deb', 'rpm'].includes(ext)) return 'program'
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub'].includes(ext))
    return 'document'
  return 'other'
}
