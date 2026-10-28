import { Notification, shell, BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import type { AppToast, DownloadItem, NotificationSettings } from '@shared/types'
import type { Store } from './store'
import { formatBytes, formatEta, formatSpeed, t } from './lang'

/**
 * Üç aşamalı bildirim sistemi:
 *  1. ÖNCE  → indirme istendiğinde (onay: Başlat/İptal)
 *  2. SIRASINDA → %25/%50/%75 eşikleri
 *  3. SONUNDA → tamamlandı / hata (Aç / Klasör aksiyonları)
 *
 * Hem Windows toast (Notification) hem uygulama içi balon (renderer'a olay).
 */
export class Notifier extends EventEmitter {
  private store: Store
  /** bildirim kimlikleri (toast'ları güncellemek/temizlemek için) */
  private activeProgress = new Map<string, Electron.Notification>()
  private progressMilestones = new Map<string, Set<number>>()
  private toastCounter = 0

  constructor(store: Store) {
    super()
    this.setMaxListeners(100)
    this.store = store
  }

  private get cfg(): NotificationSettings {
    return this.store.getSettings().notifications
  }

  private emitToast(toast: Omit<AppToast, 'id' | 'createdAt'>): void {
    if (!this.cfg.inAppToasts) return
    const full: AppToast = {
      ...toast,
      id: `t_${++this.toastCounter}_${Date.now().toString(36)}`,
      createdAt: Date.now()
    }
    this.emit('toast', full)
  }

  private sysNotificationSupported(): boolean {
    return this.cfg.systemToasts && Notification.isSupported()
  }

  /** 1. AŞAMA — indirme istendi / başlıyor */
  notifyStart(item: DownloadItem, withActions: boolean): void {
    const folder = parentFolder(item.savePath)
    const title = withActions ? t('notify.start.title') : t('notify.start.requested')
    const body = t('notify.start.body', { name: item.name, folder })

    this.emitToast({ stage: 'start', title, message: body, downloadId: item.id })

    if (!this.sysNotificationSupported()) return

    const n = new Notification({
      title,
      body,
      silent: false,
      icon: undefined,
      actions: withActions
        ? [
            { type: 'button', text: t('notify.start.actionApprove') },
            { type: 'button', text: t('notify.start.actionCancel') }
          ]
        : undefined,
      closeButtonText: withActions ? t('notify.start.actionCancel') : undefined
    })

    if (withActions) {
      n.on('action', (event, index) => {
        // 0 = Başlat, 1 = İptal
        this.emit('start-action', { id: item.id, action: index === 0 ? 'approve' : 'cancel' })
        this.focusApp()
      })
      n.on('click', () => {
        this.emit('start-action', { id: item.id, action: 'approve' })
        this.focusApp()
      })
      n.on('close', () => {
        this.emit('start-action', { id: item.id, action: 'dismiss' })
      })
    } else {
      n.on('click', () => this.focusApp())
    }
    n.show()
  }

  /** 2. AŞAMA — ilerleme eşikleri (%25/%50/%75) */
  notifyProgress(item: DownloadItem): void {
    if (!this.cfg.onProgress) return
    const pct = Math.round(item.progress.percent * 100)
    if (pct < 25) return

    let reached = this.progressMilestones.get(item.id)
    if (!reached) {
      reached = new Set()
      this.progressMilestones.set(item.id, reached)
    }
    const milestone = pct >= 75 ? 75 : pct >= 50 ? 50 : 25
    if (reached.has(milestone)) return
    reached.add(milestone)

    const title = t('notify.progress.title')
    const body = t('notify.progress.body', {
      name: item.name,
      percent: String(pct),
      speed: formatSpeed(item.progress.speed),
      remaining: formatEta(item.progress.etaSeconds)
    })

    this.emitToast({ stage: 'progress', title, message: body, downloadId: item.id, percent: item.progress.percent })

    if (!this.sysNotificationSupported()) return

    // Aynı anahtar ile toast değiştirilir: Windows'ta eski toast kapanıp yenisini açar
    const key = item.id
    const prev = this.activeProgress.get(key)
    if (prev) {
      try {
        prev.close()
      } catch {
        /* yoksay */
      }
    }
    const n = new Notification({
      title: `${title} • %${pct}`,
      body,
      silent: true
    })
    n.on('click', () => this.focusApp())
    this.activeProgress.set(key, n)
    n.show()
  }

  /** 3. AŞAMA — tamamlandı */
  notifyComplete(item: DownloadItem): void {
    this.progressMilestones.delete(item.id)
    const prev = this.activeProgress.get(item.id)
    if (prev) {
      try {
        prev.close()
      } catch {
        /* yoksay */
      }
      this.activeProgress.delete(item.id)
    }
    if (!this.cfg.onComplete) return

    const duration = item.startedAt ? (item.finishedAt ?? Date.now()) - item.startedAt : 0
    const title = t('notify.complete.title')
    const body = t('notify.complete.body', {
      name: item.name,
      size: formatBytes(item.progress.totalBytes),
      duration: formatEta(Math.round(duration / 1000))
    })

    this.emitToast({ stage: 'complete', title, message: body, downloadId: item.id, percent: 1 })

    if (this.cfg.playSound) {
      // Windows için kısa bip; Electron Notification sesi zaten çalar (silent=false)
    }

    if (!this.sysNotificationSupported()) return
    const n = new Notification({
      title,
      body,
      silent: !this.cfg.playSound,
      actions: [
        { type: 'button', text: t('notify.complete.actionOpen') },
        { type: 'button', text: t('notify.complete.actionFolder') }
      ]
    })
    n.on('action', (_e, index) => {
      if (index === 0) void shell.openPath(item.savePath)
      else void shell.showItemInFolder(item.savePath)
      this.focusApp()
    })
    n.on('click', () => {
      void shell.showItemInFolder(item.savePath)
      this.focusApp()
    })
    n.show()
  }

  /** 3. AŞAMA (alternatif) — hata */
  notifyError(item: DownloadItem): void {
    this.progressMilestones.delete(item.id)
    const prev = this.activeProgress.get(item.id)
    if (prev) {
      try {
        prev.close()
      } catch {
        /* yoksay */
      }
      this.activeProgress.delete(item.id)
    }
    if (!this.cfg.onError) return

    const title = t('notify.error.title')
    const body = t('notify.error.body', { name: item.name, error: item.errorMessage || t('err.generic') })
    this.emitToast({ stage: 'error', title, message: body, downloadId: item.id })

    if (!this.sysNotificationSupported()) return
    const n = new Notification({
      title,
      body,
      silent: true,
      actions: [{ type: 'button', text: t('common.retry') }]
    })
    n.on('action', () => {
      this.emit('retry', { id: item.id })
      this.focusApp()
    })
    n.on('click', () => this.focusApp())
    n.show()
  }

  /** Pano yakalama: URL algılandı */
  notifyClipboard(url: string): void {
    const title = t('notify.clipboard.title')
    const body = t('notify.clipboard.body', { url: truncate(url, 90) })
    this.emitToast({ stage: 'info', title, message: body })

    if (!this.sysNotificationSupported()) return
    const n = new Notification({
      title,
      body,
      silent: true,
      actions: [{ type: 'button', text: t('confirm.download') }]
    })
    n.on('action', () => {
      this.emit('clipboard-download', { url })
      this.focusApp()
    })
    n.show()
  }

  /** Ayarlar ekranındaki "test gönder" düğmesi */
  sendTest(stage: 'start' | 'progress' | 'complete' | 'error'): void {
    const fake: DownloadItem = {
      id: 'test',
      kind: 'http',
      name: 'ornek-dosya-1080p.mp4',
      url: 'https://example.com/ornek-dosya-1080p.mp4',
      savePath: 'C:\\Downloads\\IDMS2\\ornek-dosya-1080p.mp4',
      category: 'video',
      state: 'downloading',
      progress: {
        percent: stage === 'complete' ? 1 : stage === 'progress' ? 0.5 : 0.1,
        downloadedBytes: stage === 'complete' ? 734003200 : 367001600,
        totalBytes: 734003200,
        speed: 12582912,
        etaSeconds: stage === 'complete' ? null : 30,
        connections: 8
      },
      createdAt: Date.now(),
      startedAt: Date.now() - 60000,
      finishedAt: stage === 'complete' ? Date.now() : undefined,
      errorMessage: stage === 'error' ? 'Bağlantı zaman aşımı' : undefined
    }

    switch (stage) {
      case 'start':
        this.emitToast({
          stage: 'start',
          title: t('notify.start.title'),
          message: t('notify.test.start'),
          downloadId: 'test'
        })
        if (this.sysNotificationSupported()) {
          new Notification({ title: t('notify.start.title'), body: t('notify.test.start') }).show()
        }
        break
      case 'progress':
        this.progressMilestones.delete('test')
        this.notifyProgress(fake)
        if (this.sysNotificationSupported()) {
          new Notification({
            title: `${t('notify.progress.title')} • %50`,
            body: t('notify.test.progress'),
            silent: true
          }).show()
        }
        break
      case 'complete':
        this.notifyComplete(fake)
        break
      case 'error':
        this.notifyError(fake)
        break
    }
  }

  private focusApp(): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function parentFolder(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx > 0 ? p.slice(0, idx) : p
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
