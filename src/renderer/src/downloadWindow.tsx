import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DownloadWindowState } from '@shared/types'
import { setLang } from './i18n'
import { AddWindow } from './windows/AddWindow'
import { ProgressWindow } from './windows/ProgressWindow'
import { CompleteWindow } from './windows/CompleteWindow'
import { DuplicateWindow } from './windows/DuplicateWindow'
import './downloadWindow.css'

/** Dört IDM penceresinin ortak giriş noktası. Mod, main süreçten gelir. */
function DownloadWindowApp() {
  const [state, setState] = useState<DownloadWindowState | null>(null)

  useEffect(() => {
    let alive = true
    void window.dlwin
      .state()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch(() => undefined)
    const un = window.dlwin.onUpdate((s) => setState(s))
    return () => {
      alive = false
      un()
    }
  }, [])

  useEffect(() => {
    if (!state) return
    const { general } = state.settings
    setLang(general.language)
    const resolved =
      general.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : general.theme
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.lang = general.language
  }, [state?.settings])

  if (!state) {
    return (
      <div className="dlwin loading">
        <span className="spin" />
      </div>
    )
  }

  if (state.mode === 'add' && state.request) {
    return <AddWindow request={state.request} settings={state.settings} />
  }
  if (state.mode === 'duplicate' && state.request) {
    return (
      <DuplicateWindow
        request={state.request}
        existing={state.existing}
        settings={state.settings}
      />
    )
  }
  if (state.mode === 'progress' && state.item) {
    return (
      <ProgressWindow
        item={state.item}
        segments={state.segments || []}
        settings={state.settings}
      />
    )
  }
  if (state.mode === 'complete' && state.item) {
    return <CompleteWindow item={state.item} settings={state.settings} />
  }

  return (
    <div className="dlwin loading">
      <span className="muted">…</span>
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <DownloadWindowApp />
    </React.StrictMode>
  )
}
