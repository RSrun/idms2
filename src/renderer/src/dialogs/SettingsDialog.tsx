import { useEffect, useState } from 'react'
import type { ExtensionServerStatus, GeckoProfile, Settings } from '@shared/types'
import { useT } from '../i18n'
import { SUPPORTED_SITES } from '../ytdlpInfo'

const api = () => window.idms2

type Tab = 'general' | 'notifications' | 'social' | 'torrent' | 'extension' | 'about'

interface Props {
  initialTab?: string
  settings: Settings | null
  serverStatus: ExtensionServerStatus | null
  onChange: (patch: any) => Promise<Settings>
  onClose: () => void
}

export function SettingsDialog({ initialTab, settings, serverStatus, onChange, onClose }: Props) {
  const t = useT()
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || 'general')
  const [local, setLocal] = useState<Settings | null>(settings)
  const [version, setVersion] = useState('')

  useEffect(() => setLocal(settings), [settings])
  useEffect(() => {
    void api()
      .getAppInfo()
      .then((i) => setVersion(`${i.version} · Electron ${i.electron} · ${i.platform}`))
  }, [])

  const patch = (p: any) => {
    setLocal((prev) => (prev ? (merge(prev, p) as Settings) : prev))
    void onChange(p)
  }

  if (!local) return null

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'general', label: t('settings.tab.general') },
    { id: 'notifications', label: t('settings.tab.notifications') },
    { id: 'social', label: t('settings.tab.social') },
    { id: 'torrent', label: t('settings.tab.torrent') },
    { id: 'extension', label: t('settings.tab.extension') },
    { id: 'about', label: t('settings.tab.about') }
  ]

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label={t('settings.title')}>
        <div className="d-head">
          <span className="brand-mark" style={{ width: 30, height: 30, fontSize: 17 }}>
            ⚙
          </span>
          <div>
            <h2>{t('settings.title')}</h2>
            <div className="sub">IDMS2</div>
          </div>
          <button className="d-close" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        <div className="tabs">
          {tabs.map((x) => (
            <button
              key={x.id}
              className={`tab ${tab === x.id ? 'active' : ''}`}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div className="d-body" style={{ minHeight: 340 }}>
          {tab === 'general' && <GeneralTab s={local} patch={patch} />}
          {tab === 'notifications' && <NotifyTab s={local} patch={patch} />}
          {tab === 'social' && <SocialTab s={local} patch={patch} />}
          {tab === 'torrent' && <TorrentTab s={local} patch={patch} />}
          {tab === 'extension' && (
            <ExtensionTab s={local} patch={patch} status={serverStatus} />
          )}
          {tab === 'about' && <AboutTab version={version} />}
        </div>

        <div className="d-foot">
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            {t('set.connectionsNote')}
          </span>
          <button className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================ GENEL ============================ */

function GeneralTab({ s, patch }: { s: Settings; patch: (p: any) => void }) {
  const t = useT()
  return (
    <>
      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.language')}</div>
        </div>
        <div className="ctrl">
          <select
            className="select"
            style={{ width: 150 }}
            value={s.general.language}
            onChange={(e) => patch({ general: { language: e.target.value } })}
          >
            <option value="tr">Türkçe</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.theme')}</div>
        </div>
        <div className="ctrl">
          <select
            className="select"
            style={{ width: 150 }}
            value={s.general.theme}
            onChange={(e) => patch({ general: { theme: e.target.value } })}
          >
            <option value="light">{t('set.theme.light')}</option>
            <option value="dark">{t('set.theme.dark')}</option>
            <option value="system">{t('set.theme.system')}</option>
          </select>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.downloadDir')}</div>
          <div className="hint">{s.general.downloadDir}</div>
        </div>
        <div className="ctrl">
          <button
            className="btn"
            onClick={async () => {
              const dir = await api().pickDirectory(s.general.downloadDir)
              if (dir) patch({ general: { downloadDir: dir } })
            }}
          >
            {t('common.browse')}
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.maxConcurrent')}</div>
          <div className="hint">{t('set.maxConcurrentHint')}</div>
        </div>
        <div className="ctrl">
          <select
            className="select"
            style={{ width: 90 }}
            value={s.general.maxConcurrent}
            onChange={(e) => patch({ general: { maxConcurrent: Number(e.target.value) } })}
          >
            {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.segments')}</div>
          <div className="hint">{t('set.segmentsHint')}</div>
        </div>
        <div className="ctrl">
          <select
            className="select"
            style={{ width: 90 }}
            value={s.general.segmentsPerDownload}
            onChange={(e) =>
              patch({ general: { segmentsPerDownload: Number(e.target.value) } })
            }
          >
            {[1, 2, 4, 6, 8, 12, 16].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.speedLimit')}</div>
          <div className="hint">{t('set.speedLimitHint')}</div>
        </div>
        <div className="ctrl">
          <input
            className="input"
            type="number"
            min={0}
            step={0.5}
            value={s.general.speedLimitMbps}
            onChange={(e) =>
              patch({ general: { speedLimitMbps: Math.max(0, Number(e.target.value)) } })
            }
            style={{ width: 90 }}
          />
        </div>
      </div>

      <SwitchRow
        label={t('set.autoStart')}
        value={s.general.autoStart}
        onChange={(v) => patch({ general: { autoStart: v } })}
      />
      <SwitchRow
        label={t('set.confirmBefore')}
        hint={t('set.confirmBeforeHint')}
        value={s.general.confirmBeforeDownload}
        onChange={(v) => patch({ general: { confirmBeforeDownload: v } })}
      />

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.duplicatePolicy')}</div>
          <div className="hint">{t('set.duplicatePolicyHint')}</div>
        </div>
        <div className="ctrl">
          <select
            className="select"
            style={{ width: 190 }}
            value={s.general.duplicatePolicy || 'ask'}
            onChange={(e) => patch({ general: { duplicatePolicy: e.target.value } })}
          >
            <option value="ask">{t('set.duplicatePolicy.ask')}</option>
            <option value="number">{t('set.duplicatePolicy.number')}</option>
            <option value="overwrite">{t('set.duplicatePolicy.overwrite')}</option>
            <option value="continue">{t('set.duplicatePolicy.continue')}</option>
          </select>
        </div>
      </div>
      <SwitchRow
        label={t('set.monitorClipboard')}
        value={s.general.monitorClipboard}
        onChange={(v) => patch({ general: { monitorClipboard: v } })}
      />
      <SwitchRow
        label={t('set.startOnBoot')}
        value={s.general.startOnBoot}
        onChange={(v) => patch({ general: { startOnBoot: v } })}
      />
      <SwitchRow
        label={t('set.startMinimized')}
        value={s.general.startMinimized}
        onChange={(v) => patch({ general: { startMinimized: v } })}
      />
    </>
  )
}

/* ========================= BİLDİRİMLER ========================= */

function NotifyTab({ s, patch }: { s: Settings; patch: (p: any) => void }) {
  const t = useT()
  return (
    <>
      <div className="card">
        <h4>🔔 {t('set.notify.hint')}</h4>
      </div>

      <div className="section-title">{t('settings.tab.notifications')}</div>

      <SwitchRow
        label={t('set.notify.progressWindow')}
        value={s.notifications.progressWindow !== false}
        onChange={(v) => patch({ notifications: { progressWindow: v } })}
      />
      <SwitchRow
        label={t('set.notify.completeWindow')}
        value={s.notifications.completeWindow !== false}
        onChange={(v) => patch({ notifications: { completeWindow: v } })}
      />

      <SwitchRow
        label={t('set.notify.onStart')}
        value={s.notifications.onStart}
        onChange={(v) => patch({ notifications: { onStart: v } })}
      />
      <SwitchRow
        label={t('set.notify.onProgress')}
        value={s.notifications.onProgress}
        onChange={(v) => patch({ notifications: { onProgress: v } })}
      />
      <SwitchRow
        label={t('set.notify.onComplete')}
        value={s.notifications.onComplete}
        onChange={(v) => patch({ notifications: { onComplete: v } })}
      />
      <SwitchRow
        label={t('set.notify.onError')}
        value={s.notifications.onError}
        onChange={(v) => patch({ notifications: { onError: v } })}
      />

      <div className="section-title">{t('notify.toastQueue')}</div>

      <SwitchRow
        label={t('set.notify.systemToasts')}
        value={s.notifications.systemToasts}
        onChange={(v) => patch({ notifications: { systemToasts: v } })}
      />
      <SwitchRow
        label={t('set.notify.inAppToasts')}
        value={s.notifications.inAppToasts}
        onChange={(v) => patch({ notifications: { inAppToasts: v } })}
      />
      <SwitchRow
        label={t('set.notify.playSound')}
        value={s.notifications.playSound}
        onChange={(v) => patch({ notifications: { playSound: v } })}
      />

      <div className="section-title">{t('common.test')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void api().sendTestNotification('start')}>
          ⤳ {t('set.notify.onStart')}
        </button>
        <button className="btn" onClick={() => void api().sendTestNotification('progress')}>
          ⬇ {t('set.notify.onProgress')}
        </button>
        <button className="btn" onClick={() => void api().sendTestNotification('complete')}>
          ✓ {t('set.notify.onComplete')}
        </button>
        <button className="btn" onClick={() => void api().sendTestNotification('error')}>
          ! {t('set.notify.onError')}
        </button>
      </div>
    </>
  )
}

/* ========================== SOSYAL MEDYA ========================== */

function SocialTab({ s, patch }: { s: Settings; patch: (p: any) => void }) {
  const t = useT()
  const [downloading, setDownloading] = useState(false)
  const [msg, setMsg] = useState('')

  async function downloadYtdlp(): Promise<void> {
    setDownloading(true)
    setMsg(t('set.social.ytdlpDownloading'))
    try {
      const savedPath = await (window as any).idms2.fetchYtdlp()
      if (savedPath) {
        patch({ social: { ytdlpPath: savedPath } })
        setMsg(t('set.social.ytdlpReady'))
      } else {
        setMsg('')
      }
    } catch (e: any) {
      setMsg(`${t('common.error')}: ${e?.message || ''}`)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <>
      <div className="card">
        <h4>🎬 {t('set.social.sitesHint')}</h4>
        <p>{SUPPORTED_SITES.join(' · ')}</p>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.social.ytdlpPath')}</div>
          <div className="hint">{s.social.ytdlpPath || 'PATH'}</div>
        </div>
        <div className="ctrl">
          <button
            className="btn"
            onClick={async () => {
              const f = await api().pickDirectory(s.social.ytdlpPath)
              if (f) patch({ social: { ytdlpPath: f } })
            }}
          >
            {t('common.browse')}
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.social.ytdlpDownload')}</div>
          <div className="hint">{msg || t('set.social.ytdlpAuto')}</div>
        </div>
        <div className="ctrl">
          <button className="btn primary" disabled={downloading} onClick={() => void downloadYtdlp()}>
            {downloading ? <span className="spin" /> : '⬇'} {t('set.social.ytdlpDownload')}
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.social.ffmpegPath')}</div>
          <div className="hint">{t('set.social.ffmpegHint')}</div>
        </div>
        <div className="ctrl">
          <input
            className="input"
            value={s.social.ffmpegPath}
            placeholder="PATH"
            onChange={(e) => patch({ social: { ffmpegPath: e.target.value } })}
          />
        </div>
      </div>

      <SwitchRow
        label={t('set.social.passCookies')}
        hint={t('set.social.passCookiesHint')}
        value={s.social.passCookies}
        onChange={(v) => patch({ social: { passCookies: v } })}
      />

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.social.preferredQuality')}</div>
        </div>
        <div className="ctrl">
          <select
            className="select"
            style={{ width: 170 }}
            value={s.social.preferredQuality}
            onChange={(e) => patch({ social: { preferredQuality: e.target.value } })}
          >
            <option value="best">{t('media.best')}</option>
            <option value="audio">{t('media.audioOnly')}</option>
          </select>
        </div>
      </div>

      <SwitchRow
        label="Impersonate (curl_cffi)"
        hint="Bazı siteler için istemci parmak izi taklidi"
        value={s.social.impersonate}
        onChange={(v) => patch({ social: { impersonate: v } })}
      />
    </>
  )
}

/* ============================ TORRENT ============================ */

function TorrentTab({ s, patch }: { s: Settings; patch: (p: any) => void }) {
  const t = useT()
  return (
    <>
      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.torrent.saveDir')}</div>
          <div className="hint">{s.torrent.saveDir}</div>
        </div>
        <div className="ctrl">
          <button
            className="btn"
            onClick={async () => {
              const dir = await api().pickDirectory(s.torrent.saveDir)
              if (dir) patch({ torrent: { saveDir: dir } })
            }}
          >
            {t('common.browse')}
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.torrent.port')}</div>
        </div>
        <div className="ctrl">
          <input
            className="input"
            type="number"
            min={0}
            max={65535}
            value={s.torrent.port}
            onChange={(e) => patch({ torrent: { port: Number(e.target.value) || 0 } })}
            style={{ width: 100 }}
          />
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.torrent.maxConcurrent')}</div>
        </div>
        <div className="ctrl">
          <select
            className="select"
            style={{ width: 90 }}
            value={s.torrent.maxConcurrent}
            onChange={(e) => patch({ torrent: { maxConcurrent: Number(e.target.value) } })}
          >
            {[1, 2, 3, 5, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.torrent.uploadLimit')}</div>
          <div className="hint">{t('set.speedLimitHint')}</div>
        </div>
        <div className="ctrl">
          <input
            className="input"
            type="number"
            min={0}
            step={0.5}
            value={s.torrent.uploadLimitMbps}
            onChange={(e) =>
              patch({ torrent: { uploadLimitMbps: Math.max(0, Number(e.target.value)) } })
            }
            style={{ width: 90 }}
          />
        </div>
      </div>

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.torrent.seedRatio')}</div>
        </div>
        <div className="ctrl">
          <input
            className="input"
            type="number"
            min={0}
            step={0.1}
            value={s.torrent.seedRatioLimit}
            onChange={(e) =>
              patch({ torrent: { seedRatioLimit: Math.max(0, Number(e.target.value)) } })
            }
            style={{ width: 90 }}
          />
        </div>
      </div>

      <SwitchRow
        label={t('set.torrent.dht')}
        value={s.torrent.dht}
        onChange={(v) => patch({ torrent: { dht: v } })}
      />
      <SwitchRow
        label={t('set.torrent.utp')}
        value={s.torrent.utp}
        onChange={(v) => patch({ torrent: { utp: v } })}
      />
    </>
  )
}

/* ============================ EKLENTİ ============================ */

function ExtensionTab({
  s,
  patch,
  status
}: {
  s: Settings
  patch: (p: any) => void
  status: ExtensionServerStatus | null
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState(s.extension.pairingCode)
  const [gecko, setGecko] = useState<GeckoProfile[] | null>(null)
  const [geckoBusy, setGeckoBusy] = useState<string | null>(null)
  const [geckoNote, setGeckoNote] = useState<string | null>(null)

  useEffect(() => setCode(s.extension.pairingCode), [s.extension.pairingCode])

  const loadGecko = async () => {
    try {
      setGecko(await api().gecko.list())
    } catch {
      setGecko([])
    }
  }

  useEffect(() => {
    void loadGecko()
  }, [])

  const runGecko = async (p: GeckoProfile, action: 'install' | 'uninstall') => {
    setGeckoBusy(p.profileDir)
    setGeckoNote(null)
    try {
      const res =
        action === 'install'
          ? await api().gecko.install(p.profileDir)
          : await api().gecko.uninstall(p.profileDir)
      if (!res.ok) {
        setGeckoNote(`${t('set.ext.geckoError')}: ${res.error ?? ''}`)
      } else if (action === 'uninstall') {
        setGeckoNote(t('set.ext.geckoRemoved'))
      } else {
        setGeckoNote(t(res.running ? 'set.ext.geckoInstalledRunning' : 'set.ext.geckoInstalled'))
      }
      await loadGecko()
    } catch (err) {
      setGeckoNote(`${t('set.ext.geckoError')}: ${(err as Error).message}`)
    } finally {
      setGeckoBusy(null)
    }
  }

  const running = status?.running ?? false
  const clients = status?.clients ?? []

  return (
    <>
      <SwitchRow
        label={t('set.ext.enabled')}
        value={s.extension.enabled}
        onChange={(v) => patch({ extension: { enabled: v } })}
      />

      <SwitchRow
        label={t('set.ext.floatPanel')}
        hint={t('set.ext.floatPanelHint')}
        value={s.extension.floatingPanel !== false}
        onChange={(v) => patch({ extension: { floatingPanel: v } })}
      />

      <div className="setting-row">
        <div className="txt">
          <div className="lbl">{t('set.ext.status')}</div>
          <div className="hint">
            {running ? `127.0.0.1:${status?.port}` : t('status.extensionDisconnected')}
          </div>
        </div>
        <div className="ctrl">
          <span className={`pill ${running ? 'completed' : 'paused'}`}>
            <span className="dot" />
            {running ? t('common.enabled') : t('common.disabled')}
          </span>
        </div>
      </div>

      <div className="section-title">{t('set.ext.pairingCode')}</div>
      <div className="pairing-code">{code}</div>
      <p className="hint" style={{ fontSize: 12, color: 'var(--text-3)', margin: '6px 0 0' }}>
        {t('set.ext.pairingHint')}
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          className="btn"
          onClick={async () => {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? `✓ ${t('common.copied')}` : `⧉ ${t('common.copy')}`}
        </button>
        <button
          className="btn"
          onClick={async () => {
            const next = await api().regeneratePairingCode()
            setCode(next)
          }}
        >
          ⟳ {t('set.ext.regenerate')}
        </button>
      </div>
      <p className="hint" style={{ fontSize: 12, color: 'var(--text-3)', margin: '10px 0 0' }}>
        {t('set.ext.revokeHint')}
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn" onClick={() => void api().revokeExtensionPairing()}>
          ⨯ {t('set.ext.revoke')}
        </button>
      </div>

      <div className="section-title">{t('set.ext.connectedClients')}</div>
      {clients.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {t('set.ext.noClients')}
        </div>
      ) : (
        <div className="client-list">
          {clients.map((c) => (
            <div key={c.id} className="client-item">
              <span>🌐</span>
              <span>
                <b>{c.client}</b> {c.version ? `v${c.version}` : ''}
              </span>
              <span className="grow" />
              <span className="muted">{new Date(c.connectedAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">Install</div>
      <div className="card">
        <h4>🧩 {t('toolbar.extension')}</h4>
        <ul>
          <li>
            <b>Chrome / Edge / Brave:</b> <code>chrome://extensions</code> → Geliştirici modu →
            Paketlenmemiş yükle → <code>extension/chromium</code>
          </li>
        </ul>
        <p>{t('set.ext.installHint')}</p>
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={async () => {
            const dir = await api().getExtensionDir();
            void api().openPath(dir);
          }}
        >
          📂 {t('set.ext.openDir')}
        </button>
      </div>

      <div className="section-title">{t('set.ext.geckoTitle')}</div>
      <div className="card">
        <h4>🦊 {t('set.ext.geckoCardTitle')}</h4>
        {gecko === null ? (
          <p>{t('common.loading')}</p>
        ) : gecko.length === 0 ? (
          <p>{t('set.ext.geckoNone')}</p>
        ) : (
          <div className="client-list">
            {gecko.map((p) => (
              <div className="client-item" key={p.profileDir} title={p.profileDir}>
                <span>{p.browser === 'zen' ? '🌀' : '🦊'}</span>
                <span>
                  <b>{p.browserName}</b>{' '}
                  <span className="muted">
                    {p.profileName}
                    {p.isDefault ? ` · ${t('common.default')}` : ''}
                  </span>
                </span>
                {p.installed ? (
                  <span className="pill completed">
                    <span className="dot" />
                    {t('set.ext.geckoInstalledBadge')}
                  </span>
                ) : null}
                <span className="grow" />
                {p.installed ? (
                  <>
                    <button
                      className="btn"
                      disabled={geckoBusy === p.profileDir}
                      onClick={() => void runGecko(p, 'install')}
                    >
                      {t('set.ext.geckoReinstall')}
                    </button>
                    <button
                      className="btn"
                      disabled={geckoBusy === p.profileDir}
                      onClick={() => void runGecko(p, 'uninstall')}
                    >
                      {t('common.remove')}
                    </button>
                  </>
                ) : (
                  <button
                    className="btn primary"
                    disabled={geckoBusy === p.profileDir}
                    onClick={() => void runGecko(p, 'install')}
                  >
                    {t('set.ext.geckoInstall')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <p>{t('set.ext.geckoHint')}</p>
        {geckoNote ? <p style={{ color: 'var(--text-2)' }}>{geckoNote}</p> : null}
        <p style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('set.ext.geckoSignHint')}</p>
      </div>
    </>
  )
}

function extensionDir(): string {
  // Dev'de __dirname kullanılır; üretimde Electron'dan gerçek dizin alınır
  const isDev = !!(window as any).idms2;
  if (isDev && (window as any).__dirname) return (window as any).__dirname + '/extension';
  return 'extension'; // Üretimde openPath('ext:dir') ile gerçek yol açılır
}

/* ============================ HAKKINDA ============================ */

function AboutTab({ version }: { version: string }) {
  const t = useT()
  return (
    <>
      <div style={{ textAlign: 'center', padding: '18px 0 6px' }}>
        <div className="brand-mark" style={{ width: 64, height: 64, fontSize: 34, margin: '0 auto' }}>
          ⤓
        </div>
        <h3 style={{ margin: '12px 0 4px' }}>IDMS2</h3>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {t('app.tagline')}
        </div>
      </div>

      <dl className="info-grid">
        <dt>{t('set.about.version')}</dt>
        <dd className="mono">{version || '—'}</dd>
        <dt>{t('set.about.license')}</dt>
        <dd>MIT</dd>
        <dt>Credits</dt>
        <dd>{t('set.about.credits')}</dd>
        <dt>Sites</dt>
        <dd>{SUPPORTED_SITES.join(', ')}</dd>
      </dl>

      <div className="card">
        <h4>⌨️ Shortcuts</h4>
        <p>
          <code>Ctrl+J</code> — {t('toolbar.add')}
          <br />
          <code>Del</code> — {t('toolbar.remove')}
          <br />
          <code>Esc</code> — {t('common.close')}
        </p>
      </div>
    </>
  )
}

/* ============================ yardımcılar ============================ */

function SwitchRow({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="setting-row">
      <div className="txt">
        <div className="lbl">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div className="ctrl">
        <button
          className={`switch ${value ? 'on' : ''}`}
          onClick={() => onChange(!value)}
          aria-pressed={value}
          aria-label={label}
        />
      </div>
    </div>
  )
}

function merge(base: any, patchObj: any): any {
  if (patchObj === undefined || patchObj === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patchObj
  const out: any = { ...base }
  for (const k of Object.keys(patchObj)) {
    const p = patchObj[k]
    if (p === undefined) continue
    if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
      out[k] = merge(base[k], p)
    } else {
      out[k] = p
    }
  }
  return out
}
