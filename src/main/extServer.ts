import { EventEmitter } from 'events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { randomBytes, timingSafeEqual } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { AppToExtMessage, ExtToAppMessage, ExtensionServerStatus } from '@shared/types'
import type { Store } from './store'
import type { DownloadManager } from './engine/manager'

interface Client {
  id: string
  ws: WebSocket | null
  client: string
  version?: string
  /** WebSocket Origin başlığı (chrome-extension://… / moz-extension://…) */
  origin: string
  connectedAt: number
  paired: boolean
  /** HTTP /pair ile alınan token'la bağlandı */
  tokenAuthed?: boolean
  /** HTTP /rpc için yanıt toplayıcı */
  replies?: AppToExtMessage[]
}

/** Kabul edilen eklenti kökenleri (tarayıcı eklentisi şemaları). */
const EXTENSION_SCHEMES = [
  'chrome-extension:',
  'moz-extension:',
  'ms-browser-extension:',
  'safari-web-extension:'
]

const MAX_BODY = 256 * 1024
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function isExtensionOrigin(origin: string): boolean {
  if (!origin) return false
  try {
    return EXTENSION_SCHEMES.includes(new URL(origin).protocol)
  } catch {
    return false
  }
}

function isLocalOrigin(origin: string): boolean {
  if (!origin) return false
  try {
    const u = new URL(origin)
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      LOCAL_HOSTS.has(u.hostname)
    )
  } catch {
    return false
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (!ba.length || ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('Gövde 256 KB sınırını aştı'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Geçersiz JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Tarayıcı eklentisi (Chromium + Gecko) ile konuşan yerel köprü.
 *
 * Aynı port üzerinde iki taşıma sunar:
 *  - HTTP: /info, /pair, /whoami, /rpc, /status (+ CORS yalnızca eklenti kökenine)
 *  - WebSocket: canlı durum, toast ve yüzen panel olayları
 *
 * Güvenlik:
 *  - Yalnızca 127.0.0.1'e bağlanır; Host başlığı yerel olmayan istekler reddedilir
 *  - Geçerli 6 haneli eşleştirme kodu, token yalnızca eklenti kökenine verilir
 *  - Token sonrası tüm HTTP/WS çağrıları token + yetkili köken ister
 */
export class ExtensionServer extends EventEmitter {
  private wss: WebSocketServer | null = null
  private httpServer: Server | null = null
  private clients = new Map<string, Client>()
  private store: Store
  private manager: DownloadManager
  private port = 0
  private seq = 0
  /** Yüzen paneli en son besleyen istemci (bağlantı kopunca panel kapanır) */
  private floatClientId = ''
  private token = ''
  private allowedOrigins = new Set<string>()
  /** /pair başarısız denemeleri: origin -> zaman damgaları (ms) */
  private pairFailures = new Map<string, number[]>()
  private readonly PAIR_MAX_ATTEMPTS = 10
  private readonly PAIR_WINDOW_MS = 15 * 60 * 1000 // 15 dakika

  constructor(store: Store, manager: DownloadManager) {
    super()
    this.setMaxListeners(50)
    this.store = store
    this.manager = manager
    this.syncSecret()
  }

  private syncSecret(): void {
    const cfg = this.store.getSettings().extension
    this.token = cfg.token
    this.allowedOrigins = new Set(cfg.allowedOrigins || [])
  }

  get status(): ExtensionServerStatus {
    const cfg = this.store.getSettings().extension
    return {
      running: this.httpServer !== null,
      port: this.port,
      pairingCode: cfg.pairingCode,
      paired:
        this.allowedOrigins.size > 0 ||
        [...this.clients.values()].some((c) => c.paired),
      clients: [...this.clients.values()].map((c) => ({
        id: c.id,
        client: c.client,
        connectedAt: c.connectedAt,
        version: c.version
      }))
    }
  }

  async start(): Promise<boolean> {
    const cfg = this.store.getSettings().extension
    if (!cfg.enabled) return false
    if (this.httpServer) return true
    this.syncSecret()

    for (let p = cfg.port; p < cfg.port + 10; p++) {
      try {
        await this.listen(p)
        return true
      } catch {
        /* sonraki port */
      }
    }
    this.emit('log', 'hiçbir portta dinlenemedi')
    return false
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handleHttp(req, res))
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })

      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head, wss))
      server.on('clientError', (_err, socket) => {
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        } catch {
          /* yoksay */
        }
      })

      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE') reject(err)
        else {
          this.emit('log', `Köprü hatası: ${err.message}`)
          reject(err)
        }
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        server.on('error', (err) => this.emit('log', `Köprü hatası: ${err.message}`))
        const addr = server.address()
        this.httpServer = server
        this.wss = wss
        this.port = typeof addr === 'object' && addr ? addr.port : port
        this.emit('listening', this.port)
        resolve()
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  // -------------------------------------------------------------------------
  // HTTP köprüsü
  // -------------------------------------------------------------------------

  private corsHeaders(origin: string, allowed: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-IDMS-Token',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }
    if (allowed && origin) headers['Access-Control-Allow-Origin'] = origin
    return headers
  }

  private json(
    res: ServerResponse,
    code: number,
    payload: unknown,
    headers: Record<string, string> = {}
  ): void {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...headers
    })
    res.end(body)
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = String(req.headers.origin || '')
    const extensionOrigin = isExtensionOrigin(origin)
    const localOrigin = isLocalOrigin(origin)
    const allowed = extensionOrigin || localOrigin

    // DNS rebinding koruması: yalnızca yerel Host başlığı
    const hostname = String(req.headers.host || '')
      .replace(/:\d+$/, '')
      .replace(/^\[|\]$/g, '')
    if (!LOCAL_HOSTS.has(hostname)) {
      this.json(res, 421, { error: 'Yalnızca yerel bağlantı kabul edilir' })
      return
    }

    const headers = this.corsHeaders(origin, allowed)
    if (req.method === 'OPTIONS') {
      if (!allowed) {
        this.json(res, 403, { error: 'Yetkisiz köken' })
        return
      }
      res.writeHead(204, headers)
      res.end()
      return
    }

    let url: URL
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      this.json(res, 400, { error: 'Geçersiz istek' }, headers)
      return
    }
    const route = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (route === '/info') {
        if (!allowed && origin) {
          this.json(res, 403, { error: 'Yetkisiz köken' })
          return
        }
        const cfg = this.store.getSettings().extension
        this.json(
          res,
          200,
          {
            app: 'IDMS',
            version: this.appVersion(),
            protocol: 2,
            port: this.port,
            needsPairing: true,
            paired: this.allowedOrigins.size > 0,
            integration: cfg.enabled
          },
          headers
        )
        return
      }

      if (route === '/pair') {
        if (req.method !== 'POST') {
          this.json(res, 405, { error: 'POST gerekli' }, headers)
          return
        }
        if (!extensionOrigin) {
          this.json(res, 403, { error: 'Yalnızca tarayıcı eklentileri eşleşebilir' }, headers)
          return
        }
        // Rate limiting: origin başına başarısız eşleştirme deneme sınırı
        const now = Date.now()
        const failures = (this.pairFailures.get(origin) || []).filter((t) => now - t < this.PAIR_WINDOW_MS)
        if (failures.length >= this.PAIR_MAX_ATTEMPTS) {
          this.json(res, 429, { error: 'Çok fazla eşleştirme denemesi; daha sonra tekrar deneyin' }, headers)
          return
        }
        const body = await readJson(req)
        const code = String(body.code || '').trim().toUpperCase()
        const cfg = this.store.getSettings().extension
        if (!code || !safeEqual(code, cfg.pairingCode.toUpperCase())) {
          failures.push(now)
          this.pairFailures.set(origin, failures)
          this.emit('log', 'hatalı eşleştirme kodu')
          this.json(res, 401, { error: 'Eşleştirme kodu hatalı' }, headers)
          return
        }
        this.allowOrigin(origin)
        this.pairFailures.delete(origin)
        this.emit('paired', { origin, name: String(body.client || '') })
        this.emitStatus()
        this.json(
          res,
          200,
          {
            ok: true,
            token: this.token,
            port: this.port,
            app: 'IDMS',
            version: this.appVersion()
          },
          headers
        )
        return
      }

      if (route === '/whoami') {
        this.json(
          res,
          200,
          {
            origin: origin || null,
            paired: this.allowedOrigins.has(origin),
            knownExtension: extensionOrigin
          },
          headers
        )
        return
      }

      if (route === '/rpc' || route === '/status') {
        if (req.method !== 'POST' && route === '/rpc') {
          this.json(res, 405, { error: 'POST gerekli' }, headers)
          return
        }
        const token = String(req.headers['x-idms-token'] || '')
        if (!safeEqual(token, this.token)) {
          this.json(res, 401, { error: 'Token gerekli; önce eşleştirin' }, headers)
          return
        }
        if (!this.allowedOrigins.has(origin)) {
          this.json(res, 403, { error: 'Bu köken eşleştirilmemiş' }, headers)
          return
        }
        if (!this.store.getSettings().extension.enabled) {
          this.json(res, 503, { error: 'Tarayıcı entegrasyonu kapalı' }, headers)
          return
        }
        if (route === '/status') {
          this.json(
            res,
            200,
            {
              ok: true,
              paired: true,
              port: this.port,
              summary: this.manager.summary(),
              items: this.manager
                .list()
                .slice(0, 20)
                .map((i) => ({
                  id: i.id,
                  name: i.name,
                  percent: i.progress.percent,
                  state: i.state
                }))
            },
            headers
          )
          return
        }
        const body = await readJson(req)
        if (!body || typeof body.t !== 'string') {
          this.json(res, 400, { error: 'Mesaj türü (t) gerekli' }, headers)
          return
        }
        const client: Client = {
          id: `http_${++this.seq}`,
          ws: null,
          client: String(body.client || 'extension').slice(0, 40),
          version: String(body.version || '').slice(0, 20),
          origin,
          connectedAt: Date.now(),
          paired: true,
          tokenAuthed: true,
          replies: []
        }
        await this.handleMessage(client, body as ExtToAppMessage)
        const ack = client.replies?.find((r) => r.t === 'ack')
        this.json(
          res,
          200,
          {
            ok: ack ? ack.ok : true,
            id: ack?.id,
            message: ack?.message,
            replies: client.replies
          },
          headers
        )
        return
      }

      this.json(res, 404, { error: `Bilinmeyen yol: ${route}` }, headers)
    } catch (err: any) {
      this.emit('log', `HTTP hatası: ${err?.message || err}`)
      this.json(res, 500, { error: String(err?.message || err) }, headers)
    }
  }

  private allowOrigin(origin: string): void {
    if (!origin || this.allowedOrigins.has(origin)) return
    this.allowedOrigins.add(origin)
    this.store.patchSettings({
      extension: { allowedOrigins: [...this.allowedOrigins] }
    })
  }

  /** Token'ı yeniler ve tüm eklenti eşleştirmelerini iptal eder. */
  revoke(): ExtensionServerStatus {
    const token = randomBytes(24).toString('hex')
    this.allowedOrigins.clear()
    this.store.patchSettings({
      extension: { token, allowedOrigins: [] }
    })
    this.token = token
    for (const client of [...this.clients.values()]) {
      if (client.tokenAuthed && client.ws) {
        try {
          client.ws.close(4001, 'eşleştirme iptal edildi')
        } catch {
          /* yoksay */
        }
      }
    }
    this.emitStatus()
    return this.status
  }

  // -------------------------------------------------------------------------
  // WebSocket köprüsü (canlı olaylar + yüzen panel)
  // -------------------------------------------------------------------------

  private handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    wss: WebSocketServer
  ): void {
    const origin = String(req.headers.origin || '')
    let url: URL
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/' && url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    if (origin && !isExtensionOrigin(origin) && !isLocalOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const token = url.searchParams.get('token') || String(req.headers['x-idms-token'] || '')
    let tokenAuthed = false
    if (token) {
      if (!safeEqual(token, this.token) || (origin && !this.allowedOrigins.has(origin))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      tokenAuthed = true
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, req, tokenAuthed, url)
    })
  }

  private onConnection(ws: WebSocket, req: IncomingMessage, tokenAuthed: boolean, url: URL): void {
    const id = `c_${++this.seq}_${Date.now().toString(36)}`
    const client: Client = {
      id,
      ws,
      client: (url.searchParams.get('client') || (tokenAuthed ? 'IDMS extension' : 'unknown')).slice(0, 40),
      version: (url.searchParams.get('version') || '').slice(0, 20) || undefined,
      origin: String(req.headers.origin || ''),
      connectedAt: Date.now(),
      paired: tokenAuthed,
      tokenAuthed
    }
    this.clients.set(id, client)

    const cfg = this.store.getSettings().extension
    this.send(client, {
      t: 'welcome',
      appVersion: this.appVersion(),
      paired: tokenAuthed,
      pairingCode: tokenAuthed ? undefined : cfg.pairingCode
    })

    ws.on('message', (raw) => {
      let msg: ExtToAppMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        this.send(client, { t: 'ack', ok: false, message: 'geçersiz JSON' })
        return
      }
      void this.handleMessage(client, msg)
    })

    ws.on('close', () => {
      this.clients.delete(id)
      if (this.floatClientId === id) {
        this.floatClientId = ''
        this.emit('float-media', { state: 'hide', key: '' })
      }
      this.emit('client-left', client.client)
      this.emitStatus()
    })
    ws.on('error', () => {
      /* kapatma yakalanır */
    })

    this.emit('client-added', client.client)
    if (tokenAuthed) this.sendStatusTo(client)
    this.emitStatus()
  }

  // -------------------------------------------------------------------------
  // Mesaj işleme
  // -------------------------------------------------------------------------

  private async handleMessage(client: Client, msg: ExtToAppMessage): Promise<void> {
    if (!msg || typeof msg.t !== 'string') return

    // Yüzen panel yalnızca eşleşmiş (kod veya token) bağlantılardan kabul edilir.
    if (msg.t === 'float') {
      const fromExtension =
        client.origin.startsWith('chrome-extension://') ||
        client.origin.startsWith('moz-extension://')
      if (!fromExtension) {
        this.send(client, { t: 'ack', ok: false, message: 'yetkisiz köken' })
        return
      }
      if (!client.paired) {
        this.send(client, { t: 'ack', ok: false, message: 'eşleştirme gerekli' })
        return
      }
      this.floatClientId = client.id
      const media = msg.media
      const rect = msg.rect
      const sources = Array.isArray((media as any)?.sources)
        ? ((media as any).sources as any[])
            .slice(0, 8)
            .map((s) => ({
              url: String(s?.url || '').slice(0, 2048),
              mime: s?.mime ? String(s.mime).slice(0, 80) : undefined,
              label: s?.label ? String(s.label).slice(0, 40) : undefined
            }))
            .filter((s) => /^https?:\/\//i.test(s.url))
        : []
      this.emit('float-media', {
        state: msg.state,
        key: String(msg.key || (media && media.url) || '').slice(0, 2048),
        media:
          media && typeof media.url === 'string'
            ? {
                url: String(media.url).slice(0, 2048),
                pageUrl: String(media.pageUrl || '').slice(0, 2048),
                title: String(media.title || '').slice(0, 300),
                pageTitle: String(media.pageTitle || '').slice(0, 300),
                kind: media.kind === 'audio' ? 'audio' : 'video',
                duration: typeof media.duration === 'number' ? media.duration : null,
                direct: media.direct === true,
                needsExtractor: media.needsExtractor === true,
                sources: sources.length ? sources : undefined
              }
            : undefined,
        rect:
          rect && [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === 'number')
            ? {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
              }
            : undefined
      })
      return
    }

    // Eşleştirme kontrolü: hello dışındaki her şey paired gerektirir
    if (msg.t !== 'hello' && msg.t !== 'ping' && !client.paired) {
      this.send(client, { t: 'ack', ok: false, message: 'eşleştirme gerekli' })
      return
    }

    switch (msg.t) {
      case 'hello': {
        client.client = String(msg.client || 'extension').slice(0, 40)
        client.version = String(msg.version || '').slice(0, 20)
        const cfg = this.store.getSettings().extension
        const codeOk =
          typeof msg.pairingCode === 'string' &&
          msg.pairingCode.toUpperCase() === cfg.pairingCode.toUpperCase()
        if (codeOk) {
          client.paired = true
          this.send(client, {
            t: 'welcome',
            appVersion: this.appVersion(),
            paired: true
          })
          this.emit('paired', { origin: client.origin, name: client.client })
          this.emitStatus()
          this.sendStatusTo(client)
        } else {
          this.send(client, {
            t: 'welcome',
            appVersion: this.appVersion(),
            paired: false,
            pairingCode: cfg.pairingCode
          })
          this.send(client, { t: 'ack', ok: false, message: 'eşleştirme kodu hatalı' })
        }
        break
      }

      case 'ping':
        this.send(client, { t: 'pong' })
        break

      case 'open-app':
        this.emit('open-app-requested')
        this.send(client, { t: 'ack', ok: true, ref: 'open-app' })
        break

      case 'detect': {
        const items = Array.isArray(msg.items) ? msg.items.slice(0, 100) : []
        const page = msg.page || { url: '', title: '' }
        this.emit('media-detected', {
          count: items.length,
          title: String(page.title || page.url || '').slice(0, 200)
        })
        this.send(client, { t: 'ack', ok: true, ref: 'detect' })
        break
      }

      case 'download': {
        const url = typeof msg.url === 'string' ? msg.url.trim() : ''
        if (!/^https?:\/\//i.test(url)) {
          this.send(client, { t: 'ack', ok: false, message: 'geçersiz URL' })
          break
        }
        try {
          const item = await this.manager.add({
            url,
            pageUrl: msg.pageUrl,
            name: msg.name,
            silent: false // onay ayarı yöneticide uygulanır
          })
          this.send(client, { t: 'ack', ok: true, id: item.id })
          this.emit('download-requested', { url, name: msg.name })
        } catch (err: any) {
          this.send(client, { t: 'ack', ok: false, message: String(err?.message || err) })
        }
        break
      }

      case 'download-media': {
        const url = typeof msg.url === 'string' ? msg.url.trim() : ''
        if (!/^https?:\/\//i.test(url)) {
          this.send(client, { t: 'ack', ok: false, message: 'geçersiz URL' })
          break
        }
        this.emit('media-download-requested', {
          url,
          pageUrl: msg.pageUrl,
          quality: msg.quality,
          cookies: msg.cookies
        })
        this.send(client, { t: 'ack', ok: true, ref: 'download-media' })
        break
      }

      case 'probe': {
        this.emit('probe-requested', { url: msg.url })
        break
      }

      default:
        this.send(client, { t: 'ack', ok: false, message: 'bilinmeyen mesaj' })
    }
  }

  private appVersion(): string {
    return process.env.npm_package_version || '1.0.0'
  }

  send(client: Client, msg: AppToExtMessage): void {
    if (client.replies) {
      client.replies.push(msg)
      return
    }
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(msg))
      } catch {
        /* yoksay */
      }
    }
  }

  /** Tüm bağlı (eşleşmiş) eklentilere yayın */
  broadcast(msg: AppToExtMessage): void {
    for (const c of this.clients.values()) {
      if (c.paired) this.send(c, msg)
    }
  }

  /** İndirme durumu özetini eklentiye iletir (rozet için) */
  sendStatusTo(client: Client): void {
    const items = this.manager.list().slice(0, 20)
    this.send(client, {
      t: 'status',
      ...this.manager.summary(),
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        percent: i.progress.percent,
        state: i.state
      }))
    })
  }

  broadcastStatus(): void {
    const items = this.manager.list().slice(0, 20)
    this.broadcast({
      t: 'status',
      ...this.manager.summary(),
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        percent: i.progress.percent,
        state: i.state
      }))
    })
  }

  broadcastToast(title: string, message: string, stage: 'start' | 'progress' | 'complete' | 'error'): void {
    this.broadcast({ t: 'toast', title, message, stage })
  }

  private emitStatus(): void {
    this.emit('status', this.status)
  }

  async stop(): Promise<void> {
    for (const c of this.clients.values()) {
      try {
        c.ws?.close()
      } catch {
        /* yoksay */
      }
    }
    this.clients.clear()
    this.floatClientId = ''
    try {
      this.wss?.close()
    } catch {
      /* yoksay */
    }
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve()
      const done = (): void => resolve()
      this.httpServer.close(done)
      setTimeout(done, 1000)
    })
    this.wss = null
    this.httpServer = null
    this.port = 0
    this.emitStatus()
  }
}
