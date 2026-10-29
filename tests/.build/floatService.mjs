// src/main/floatService.ts
function floatMediaKey(media, key) {
  const given = typeof key === "string" ? key.trim() : "";
  if (given) return given.slice(0, 2e3);
  return `${media.pageUrl || ""}|${media.url || ""}|${media.title || ""}`.slice(0, 2e3);
}
var FloatService = class {
  deps;
  /** Medya anahtarına göre kalite sonuçları (aynı video tekrar açılınca beklemesin) */
  results = /* @__PURE__ */ new Map();
  /** Panelde listelenen satırlar; seçilen format kimliği buradan çözülür */
  rows = /* @__PURE__ */ new Map();
  /** Aynı medya için eşzamanlı yoklamaları birleştirir */
  running = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.deps = deps;
  }
  get enabled() {
    const ext = this.deps.store.getSettings().extension;
    return ext.enabled && ext.floatingPanel !== false;
  }
  get language() {
    return this.deps.store.getSettings().general.language === "en" ? "en" : "tr";
  }
  /** Panelin kalite listesi (önbellekli). */
  async formats(media, key) {
    const k = floatMediaKey(media, key);
    if (!this.enabled) {
      return { ok: false, formats: [], note: "", language: this.language };
    }
    const cached = this.results.get(k);
    if (cached) return this.reply(k, cached);
    let pending = this.running.get(k);
    if (!pending) {
      pending = this.probe(media);
      this.running.set(k, pending);
      pending.finally(() => {
        if (this.running.get(k) === pending) this.running.delete(k);
      });
    }
    const res = await pending;
    return this.reply(k, res);
  }
  /** Panelde bir satır seçildiğinde indirmeyi başlatır. */
  async download(media, kind, formatId, key) {
    if (!this.enabled) return { ok: false, message: "" };
    const k = floatMediaKey(media, key);
    const rows = this.rows.get(k) || [];
    let format;
    if (formatId) {
      format = rows.find((f) => f.formatId === formatId);
      if (!format) return { ok: false, message: "" };
    } else {
      const ofKind = rows.filter((f) => f.kind === kind);
      format = ofKind.find((f) => f.best) || ofKind[0];
    }
    return this.deps.download(media, kind, format);
  }
  /** "Formatlar…" → ana pencerede ayrıntılı biçim penceresi. */
  openFormats(media) {
    if (!this.enabled) return;
    this.deps.openFormats(media);
  }
  showMainWindow() {
    this.deps.showMainWindow();
  }
  async probe(media) {
    try {
      return await this.deps.probeFormats(media);
    } catch (err) {
      return { ok: false, formats: [], note: String(err?.message || err) };
    }
  }
  reply(key, res) {
    this.remember(key, res);
    return {
      ok: res.ok,
      formats: res.formats,
      note: res.note,
      language: this.language
    };
  }
  remember(key, res) {
    this.results.set(key, res);
    this.rows.set(key, res.formats);
    while (this.results.size > 24) {
      const oldest = this.results.keys().next().value;
      if (oldest === void 0) break;
      this.results.delete(oldest);
      this.rows.delete(oldest);
    }
  }
};
export {
  FloatService,
  floatMediaKey
};
