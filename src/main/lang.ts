import type { Lang } from '@shared/i18n'
import { translate, type I18nKey } from '@shared/i18n'

/**
 * Main sürecinin dili (bildirim metinleri buradan çevrilir).
 * Settings.general.language değiştiğinde güncellenir.
 */
let currentLang: Lang = 'tr'

export function setLanguage(lang: Lang): void {
  currentLang = lang === 'en' ? 'en' : 'tr'
}

export function t(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(currentLang, key, params)
}

/** Bayt biçimlendirme: 1.2 GB gibi */
export function formatBytes(bytes: number, lang: Lang = currentLang): string {
  if (!isFinite(bytes) || bytes < 0) return '—'
  const units = ['common.bytes', 'common.kb', 'common.mb', 'common.gb', 'common.tb'] as const
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  const digits = u === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2
  return `${v.toFixed(digits)} ${translate(lang, units[u])}`
}

export function formatSpeed(bytesPerSec: number, lang: Lang = currentLang): string {
  return `${formatBytes(bytesPerSec, lang)}${translate(lang, 'common.perSecond')}`
}

/** Kalan süreyi "2 sa 13 dk" gibi biçimlendir */
export function formatEta(seconds: number | null, lang: Lang = currentLang): string {
  if (seconds === null || !isFinite(seconds) || seconds < 0) return '—'
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
