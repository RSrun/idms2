import { useCallback, useEffect, useState } from 'react'
import { translate, type I18nKey, type Lang } from '@shared/i18n'

/**
 * Dili global store'dan (settings) izleyen çeviri hook'u.
 * App ilk açılışta dili yükler; Settings değişince yeniden render olur.
 */
let currentLang: Lang = 'tr'
const listeners = new Set<() => void>()

export function setLang(lang: Lang): void {
  if (lang === currentLang) return
  currentLang = lang
  listeners.forEach((l) => l())
}

export function getLang(): Lang {
  return currentLang
}

export function useT(): (key: I18nKey, params?: Record<string, string | number>) => string {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return useCallback(
    (key: I18nKey, params?: Record<string, string | number>) => translate(currentLang, key, params),
    []
  )
}
