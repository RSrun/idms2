import { useEffect, useState } from 'react'
import type { DownloadItem, ExtensionServerStatus } from '@shared/types'
import { useT } from '../i18n'
import { formatSpeed } from '../format'

const api = () => window.idms2

interface Props {
  downloads: DownloadItem[]
  serverStatus: ExtensionServerStatus | null
  onOpenExtension: () => void
}

export function StatusBar({ downloads, serverStatus, onOpenExtension }: Props) {
  const t = useT()
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 30000)
    return () => clearInterval(timer)
  }, [])

  const active = downloads.filter((d) => d.state === 'downloading')
  const totalSpeed = active.reduce((a, d) => a + (d.progress.speed || 0), 0)
  const queued = downloads.filter(
    (d) => d.state === 'queued' || d.state === 'resolving' || d.state === 'confirming'
  ).length
  const doneToday = downloads.filter(
    (d) => d.state === 'completed' && d.finishedAt && Date.now() - d.finishedAt < 86400000
  ).length

  const connected = (serverStatus?.clients.length ?? 0) > 0

  return (
    <footer className="statusbar">
      <span className="sb-item">
        ⬇ <b>{active.length}</b> {t('status.active')}
      </span>
      <span className="sb-item">
        📥 <b>{formatSpeed(totalSpeed)}</b> {t('status.totalSpeed')}
      </span>
      <span className="sb-item">
        ⏳ <b>{queued}</b> {t('status.queued')}
      </span>
      <span className="sb-item">
        ✓ <b>{doneToday}</b> {t('status.done')}
      </span>

      <span className="grow" />

      <button
        className={`conn ${connected ? 'on' : 'off'}`}
        onClick={onOpenExtension}
        title={connected ? t('status.extensionConnected') : t('status.extensionHelp')}
      >
        <span className="led" />
        {connected
          ? `${t('status.extensionConnected')} · ${serverStatus!.port}`
          : t('status.extensionDisconnected')}
      </button>

      <span className="sb-item mono muted">
        {clock.toLocaleTimeString(t('set.language') === 'Türkçe' ? 'tr-TR' : 'en-GB', {
          hour: '2-digit',
          minute: '2-digit'
        })}
      </span>
    </footer>
  )
}
