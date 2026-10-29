import type { FloatFormat, FloatFormatsReply, FloatMediaInfo } from '@shared/types'
import type { FloatProbeResult } from './floatFormats'
import type { Store } from './store'

export interface FloatServiceDeps {
  store: Store
  /** Seçilen kalite/ses satırını indirir (format yoksa en iyi kalite) */
  download: (
    media: FloatMediaInfo,
    kind: 'video' | 'audio',
    format?: FloatFormat
  ) => Promise<{ ok: boolean; message?: string }>
  /** Video kalitelerini ve ses dosyalarını hazırlar */
  probeFormats: (media: FloatMediaInfo) => Promise<FloatProbeResult>
  /** Format seçim penceresini ana pencerede açar */
  openFormats: (media: FloatMediaInfo) => void
  /** Ana pencereyi öne getirir */
  showMainWindow: () => void
}

/** Panelin aynı medyayı eşlemek için kullandığı anahtar (en fazla 2000 karakter). */
export function floatMediaKey(media: FloatMediaInfo, key?: string): string {
  const given = typeof key === 'string' ? key.trim() : ''
  if (given) return given.slice(0, 2000)
  return `${media.pageUrl || ''}|${media.url || ''}|${media.title || ''}`.slice(0, 2000)
}

/**
 * Yüzen IDMS panelinin uygulama tarafı.
 *
 * Panel artık tarayıcı sayfasının içinde (içerik betiğinin gölge DOM'unda)
 * çizilir; burada pencere/konum/odak yönetimi yoktur. Uygulama yalnızca
 * kalite listesini hazırlar, seçilen satırı indirir ve "Formatlar…" gibi
 * eylemleri ana pencereye yönlendirir.
 */
export class FloatService {
  private deps: FloatServiceDeps
  /** Medya anahtarına göre kalite sonuçları (aynı video tekrar açılınca beklemesin) */
  private results = new Map<string, FloatProbeResult>()
  /** Panelde listelenen satırlar; seçilen format kimliği buradan çözülür */
  private rows = new Map<string, FloatFormat[]>()
  /** Aynı medya için eşzamanlı yoklamaları birleştirir */
  private running = new Map<string, Promise<FloatProbeResult>>()

  constructor(deps: FloatServiceDeps) {
    this.deps = deps
  }

  get enabled(): boolean {
    const ext = this.deps.store.getSettings().extension
    return ext.enabled && ext.floatingPanel !== false
  }

  get language(): 'tr' | 'en' {
    return this.deps.store.getSettings().general.language === 'en' ? 'en' : 'tr'
  }

  /** Panelin kalite listesi (önbellekli). */
  async formats(media: FloatMediaInfo, key?: string): Promise<FloatFormatsReply> {
    const k = floatMediaKey(media, key)
    if (!this.enabled) {
      return { ok: false, formats: [], note: '', language: this.language }
    }

    const cached = this.results.get(k)
    if (cached) return this.reply(k, cached)

    let pending = this.running.get(k)
    if (!pending) {
      pending = this.probe(media)
      this.running.set(k, pending)
      pending.finally(() => {
        if (this.running.get(k) === pending) this.running.delete(k)
      })
    }
    const res = await pending
    return this.reply(k, res)
  }

  /** Panelde bir satır seçildiğinde indirmeyi başlatır. */
  async download(
    media: FloatMediaInfo,
    kind: 'video' | 'audio',
    formatId: string | undefined,
    key?: string
  ): Promise<{ ok: boolean; message?: string }> {
    if (!this.enabled) return { ok: false, message: '' }
    const k = floatMediaKey(media, key)
    const rows = this.rows.get(k) || []
    let format: FloatFormat | undefined
    if (formatId) {
      format = rows.find((f) => f.formatId === formatId)
      // Liste önbellekten düşmüşse uydurma bir satırla indirme başlatma.
      if (!format) return { ok: false, message: '' }
    } else {
      const ofKind = rows.filter((f) => f.kind === kind)
      format = ofKind.find((f) => f.best) || ofKind[0]
    }
    return this.deps.download(media, kind, format)
  }

  /** "Formatlar…" → ana pencerede ayrıntılı biçim penceresi. */
  openFormats(media: FloatMediaInfo): void {
    if (!this.enabled) return
    this.deps.openFormats(media)
  }

  showMainWindow(): void {
    this.deps.showMainWindow()
  }

  private async probe(media: FloatMediaInfo): Promise<FloatProbeResult> {
    try {
      return await this.deps.probeFormats(media)
    } catch (err: any) {
      return { ok: false, formats: [], note: String(err?.message || err) }
    }
  }

  private reply(key: string, res: FloatProbeResult): FloatFormatsReply {
    this.remember(key, res)
    return {
      ok: res.ok,
      formats: res.formats,
      note: res.note,
      language: this.language
    }
  }

  private remember(key: string, res: FloatProbeResult): void {
    this.results.set(key, res)
    this.rows.set(key, res.formats)
    // Bellek sınırsız büyümesin: en eski girdiler düşer.
    while (this.results.size > 24) {
      const oldest = this.results.keys().next().value
      if (oldest === undefined) break
      this.results.delete(oldest)
      this.rows.delete(oldest)
    }
  }
}
