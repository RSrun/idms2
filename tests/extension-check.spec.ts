import { test as base, expect, chromium } from '@playwright/test'
import { WebSocketServer } from 'ws'
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const extRoot = join(root, 'extension')
const sharedDir = join(extRoot, 'shared')
const chromiumExtDir = join(extRoot, 'chromium')

/**
 * `--load-extension` yalnızca kalıcı (persistent) bağlamda çalışır; Playwright'ın
 * varsayılan `context` fixture'ı kalıcı olmadığı için eklenti hiç yüklenmiyor.
 * Profil, depoyu kirletmemek için sistem geçici klasöründe tutulur.
 */
const test = base.extend({
  context: async ({}, use) => {
    const profile = join(tmpdir(), `idms2-ext-profile-${randomUUID()}`)
    const ctx = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${chromiumExtDir}`,
        `--load-extension=${chromiumExtDir}`
      ]
    })
    await use(ctx)
    await ctx.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }
})

type Variant = 'chromium' | 'firefox' | 'gecko'
const dirOf = (v: Variant) => join(extRoot, v)
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const readMf = (v: Variant) => readJson(join(dirOf(v), 'manifest.json'))

/** Manifest + referanslanan dosyalar + ikonlar + popup bağlantıları + JS sözdizimi. */
function validateManifest(v: Variant): string[] {
  const dir = dirOf(v)
  const mf = readMf(v)
  const issues: string[] = []

  if (mf.manifest_version !== 3) issues.push(`manifest_version=3 olmalı (=${mf.manifest_version})`)
  if (!mf.name) issues.push('name eksik')
  if (!mf.version) issues.push('version eksik')

  const refs: string[] = []
  if (mf.background?.service_worker) refs.push(mf.background.service_worker)
  if (mf.background?.scripts) refs.push(...mf.background.scripts)
  if (mf.action?.default_popup) refs.push(mf.action.default_popup)
  for (const cs of mf.content_scripts ?? []) {
    if (!cs.matches?.length) issues.push('content_scripts.matches eksik')
    refs.push(...(cs.js ?? []), ...(cs.css ?? []))
    for (const m of cs.matches ?? []) {
      if (!/^https?:\/\//.test(m)) issues.push(`matches http(s) olmalı: ${m}`)
    }
  }
  refs.push(...Object.values(mf.icons ?? {}))
  refs.push(...Object.values(mf.action?.default_icon ?? {}))

  for (const r of refs) {
    if (!existsSync(join(dir, r))) issues.push(`manifest referansı eksik: ${r}`)
    else if (r.endsWith('.js')) {
      const res = spawnSync(process.execPath, ['--check', join(dir, r)], { encoding: 'utf8' })
      if (res.status !== 0) issues.push(`sözdizimi hatası ${r}: ${(res.stderr || '').split('\n')[0]}`)
    }
  }

  const popup = mf.action?.default_popup
  if (popup && existsSync(join(dir, popup))) {
    const html = readFileSync(join(dir, popup), 'utf8')
    for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const ref = m[1]
      if (/^(https?:|data:|#)/.test(ref)) continue
      if (!existsSync(join(dir, ref))) issues.push(`${popup} içinde eksik dosya: ${ref}`)
    }
  }

  if (!mf.permissions?.includes('storage')) issues.push('storage izni eksik')
  if (!mf.permissions?.includes('downloads')) issues.push('downloads izni eksik')
  if (!mf.permissions?.includes('webRequest')) issues.push('webRequest izni eksik')
  if (!mf.permissions?.includes('contextMenus')) issues.push('contextMenus izni eksik')
  if (!mf.host_permissions?.length) issues.push('host_permissions eksik')
  return issues
}

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  )
}

test.describe('Eklenti yapı doğrulaması', () => {
  test('chromium manifestı ve dosyaları geçerli', () => {
    expect(validateManifest('chromium')).toEqual([])
    const mf = readMf('chromium')
    expect(mf.name).toBe('IDMS Download Manager')
    expect(mf.version).toBe('1.1.0')
    expect(mf.background?.service_worker, 'chromium MV3 service_worker zorunlu').toBe('background.js')
    expect(mf.browser_specific_settings, 'chromium manifestında gecko ayarı olmamalı').toBeUndefined()
  })

  test('firefox ve gecko manifestları geçerli', () => {
    for (const v of ['firefox', 'gecko'] as Variant[]) {
      expect(validateManifest(v), v).toEqual([])
      const mf = readMf(v)
      expect(mf.name).toBe('IDMS Download Manager')
      expect(mf.manifest_version).toBe(3)
      expect(mf.background?.scripts, `${v} MV3 background.scripts zorunlu`).toContain('background.js')
      expect(mf.background?.service_worker, `${v} manifestında service_worker olmamalı`).toBeUndefined()
      expect(mf.browser_specific_settings?.gecko?.id).toBe('idms2@idms2.app')
      expect(mf.browser_specific_settings?.gecko?.strict_min_version).toBeTruthy()
    }
  })

  test('shared → chromium/firefox/gecko kopyaları birebir aynı', () => {
    const files = walk(sharedDir)
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) {
      const a = readFileSync(join(sharedDir, f))
      for (const v of ['chromium', 'firefox', 'gecko'] as Variant[]) {
        const dest = join(dirOf(v), f)
        expect(existsSync(dest), `${v}/${f} eksik`).toBe(true)
        if (existsSync(dest)) expect(a.equals(readFileSync(dest)), `${v}/${f} shared ile farklı`).toBe(true)
      }
    }
  })

  test('hedef klasörlerde kaynak dışı dosya yok', () => {
    const sharedFiles = new Set(walk(sharedDir))
    for (const v of ['chromium', 'firefox', 'gecko'] as Variant[]) {
      for (const f of walk(dirOf(v))) {
        if (f === 'manifest.json') continue
        expect(sharedFiles.has(f), `${v}/${f} shared kaynağında yok`).toBe(true)
      }
    }
  })

  test('tüm eklenti JS dosyaları sözdizimsel olarak geçerli', () => {
    for (const v of ['chromium', 'firefox', 'gecko'] as Variant[]) {
      const files = readdirSync(dirOf(v)).filter((f) => f.endsWith('.js'))
      expect(files.length).toBeGreaterThanOrEqual(3)
      for (const f of files) {
        const res = spawnSync(process.execPath, ['--check', join(dirOf(v), f)], { encoding: 'utf8' })
        expect(res.status, `${v}/${f}: ${res.stderr}`).toBe(0)
      }
    }
  })
})

/** Sahte IDMS uygulaması: gerçek köprü protokolü (HTTP /info /pair /rpc /status + WS). */
type Msg = Record<string, any>

const TEST_CODE = 'TEST01'
const TEST_TOKEN = 'test-token-0123456789abcdef0123456789'

async function startFakeApp() {
  const rpc: Msg[] = []
  const wsMessages: Msg[] = []
  const requests: Array<{ method: string; url: string; origin: string; token: string }> = []
  const wsOrigins: string[] = []
  let paired = false
  let markWs: () => void = () => {}
  const wsReady = new Promise<void>((res) => (markWs = res))

  const server: Server = createServer(async (req, res) => {
    const origin = String(req.headers.origin || '')
    const token = String(req.headers['x-idms-token'] || '')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* geçersiz gövde */
    }
    requests.push({ method: req.method || '', url: req.url || '', origin, token })

    const cors: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-IDMS-Token',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin'
    }
    if (origin) cors['Access-Control-Allow-Origin'] = origin

    const json = (code: number, data: unknown) => {
      const s = JSON.stringify(data)
      res.writeHead(code, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(s)
      })
      res.end(s)
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    if (req.url === '/info') {
      json(200, {
        app: 'IDMS',
        version: '1.0.0-test',
        protocol: 2,
        port: 9789,
        needsPairing: true,
        paired,
        integration: true
      })
      return
    }
    if (req.url === '/pair' && req.method === 'POST') {
      if (!/^chrome-extension:\/\//.test(origin)) {
        json(403, { error: 'Yalnızca tarayıcı eklentileri eşleşebilir' })
        return
      }
      if (String(body?.code || '').toUpperCase() !== TEST_CODE) {
        json(401, { error: 'Eşleştirme kodu hatalı' })
        return
      }
      paired = true
      json(200, { ok: true, token: TEST_TOKEN, port: 9789, app: 'IDMS', version: '1.0.0-test' })
      return
    }
    if (req.url === '/status' || (req.url === '/rpc' && req.method === 'POST')) {
      if (token !== TEST_TOKEN) {
        json(401, { error: 'Token gerekli; önce eşleştirin' })
        return
      }
      if (req.url === '/status') {
        json(200, {
          ok: true,
          paired: true,
          port: 9789,
          summary: { active: 0, queued: 0, totalSpeed: 0 },
          items: []
        })
        return
      }
      rpc.push(body)
      json(200, { ok: true, id: `fake-${rpc.length}`, replies: [{ t: 'ack', ok: true }] })
      return
    }
    json(404, { error: 'bilinmeyen yol' })
  })

  await new Promise<void>((res, rej) => {
    server.once('error', (e: any) =>
      rej(new Error(`9789 portu açılamadı (IDMS çalışıyor mu?): ${e.message}`))
    )
    server.listen(9789, '127.0.0.1', res)
  })

  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    wsOrigins.push(String(req.headers.origin || ''))
    markWs()
    ws.on('message', (raw) => {
      try {
        wsMessages.push(JSON.parse(String(raw)))
      } catch {
        /* yoksay */
      }
    })
  })

  return {
    rpc,
    wsMessages,
    requests,
    wsOrigins,
    wsReady,
    get paired() {
      return paired
    },
    async close() {
      for (const c of wss.clients) c.terminate()
      await new Promise<void>((res) => wss.close(() => res()))
      server.closeAllConnections?.()
      await new Promise<void>((res) => server.close(() => res()))
    }
  }
}

/** İçerik betiği + webRequest + indirme devralma için yerel HTTP sunucusu. */
async function startMediaServer() {
  const mediaPath = '/media/ornek-video.mp4'
  const filePath = '/files/arsiv.bin'
  const server: Server = createServer((req, res) => {
    const url = req.url || '/'
    if (url.startsWith(mediaPath)) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': '2048',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      })
      res.end(Buffer.alloc(2048))
      return
    }
    if (url.startsWith(filePath)) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="arsiv.bin"',
        'Content-Length': '512',
        'Cache-Control': 'no-store'
      })
      res.end(Buffer.alloc(512))
      return
    }
    if (url.startsWith('/feed')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Akış</title>
        <style>
          html, body { margin: 0; padding: 0; }
          article { padding: 8px; }
          video { display: block; width: 480px; height: 270px; }
        </style></head>
        <body>
          <article id="card">
            <a id="post" href="/reel/CxYz7890/">
              <video id="v" preload="auto" autoplay muted loop controls></video>
            </a>
          </article>
          <script>
            fetch('${mediaPath}')
              .then((r) => r.blob())
              .then((b) => { document.getElementById('v').src = URL.createObjectURL(b) })
          <\/script>
        </body></html>`)
      return
    }
    if (url.startsWith('/scroll')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Kaydırma</title>
        <style>
          html, body { margin: 0; padding: 0; }
          video { display: block; width: 480px; height: 270px; }
          #tall { height: 2600px; background: #eee; }
        </style></head>
        <body>
          <video id="v" src="${mediaPath}" preload="auto" controls></video>
          <div id="tall"></div>
        </body></html>`)
      return
    }
    if (url.startsWith('/sticky')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Yapışkan başlık</title>
        <style>
          html, body { margin: 0; padding: 0; }
          header { position: fixed; top: 0; left: 0; right: 0; height: 64px; z-index: 5; background: #1f6feb; }
          header h1 { margin: 0; color: #fff; font: 16px/64px sans-serif; }
          video { display: block; width: 480px; height: 270px; }
        </style></head>
        <body>
          <header id="bar"><h1>Yapışkan başlık</h1></header>
          <video id="v" src="${mediaPath}" preload="auto" controls></video>
        </body></html>`)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Medya sayfası</title></head>
      <body>
        <h1>Test sayfası</h1>
        <video id="v" src="${mediaPath}" preload="auto" width="480" height="270" controls></video>
        <a id="dl" href="${mediaPath}">videoyu indir</a>
      </body></html>`)
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as { port: number }).port
  return {
    mediaPath,
    filePath,
    port,
    base: `http://127.0.0.1:${port}`,
    mediaUrl: `http://127.0.0.1:${port}${mediaPath}`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((res) => server.close(() => res()))
    }
  }
}

async function extensionId(context: import('@playwright/test').BrowserContext) {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 25000 }))
  return { sw, id: new URL(sw.url()).host }
}

test.describe('Chromium — canlı eklenti', () => {
  test.describe.configure({ mode: 'serial' })

  test('eklenti yükleniyor, popup açılıyor', async ({ context }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-extension', 'yalnızca chromium projesi')

    const { sw, id } = await extensionId(context)
    expect(sw.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/)

    const manifest = await sw.evaluate(() => chrome.runtime.getManifest())
    expect(manifest.name).toBe('IDMS Download Manager')
    expect(manifest.version).toBe('1.1.0')
    expect(manifest.manifest_version).toBe(3)

    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html`)
    await expect(popup.locator('header')).toBeVisible()
    await expect(popup.locator('#status-text')).toContainText('Uygulama kapalı')

    // Uygulama kapalıyken de eşleştirme kodu alanı görünür olmalı; alanın
    // nerede olduğunu bilmeyen kullanıcı eşleştiremiyordu.
    await expect(popup.locator('#pair-panel')).toBeVisible()
    await expect(popup.locator('#pair-code')).toBeVisible()
    await expect(popup.locator('#pair-code')).toBeDisabled()
    await expect(popup.locator('#pair-offline')).toBeVisible()
    await expect(popup.locator('#pair-btn')).toBeDisabled()
    await popup.close()
  })

  test('eşleştirme → algılama → bağlantı yakalama → devralma → yüzen panel', async ({
    context
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-extension', 'yalnızca chromium projesi')

    const app = await startFakeApp()
    const media = await startMediaServer()

    try {
      const { id } = await extensionId(context)
      const popup = await context.newPage()
      await popup.goto(`chrome-extension://${id}/popup.html`)

      /* --- 1. Eşleştirme: yalnızca 6 haneli kod --- */
      await expect(popup.locator('#pair-panel')).toBeVisible({ timeout: 20000 })
      await popup.locator('#pair-code').fill('test01')
      await popup.locator('#pair-btn').click()
      await expect(popup.locator('#status-text')).toContainText('Bağlı', { timeout: 20000 })
      expect(app.paired, 'uygulama tarafında eşleşti').toBe(true)

      const pairReq = app.requests.find((r) => r.url === '/pair')
      expect(pairReq, '/pair isteği geldi').toBeTruthy()
      expect(pairReq?.origin, 'eklenti kökeni gönderildi').toMatch(/^chrome-extension:\/\//)

      // Canlı WS: token + eklenti kökeni
      await app.wsReady
      expect(app.wsOrigins[0], 'WS el sıkışmasında eklenti kökeni').toMatch(/^chrome-extension:\/\//)

      /* --- 2. Ağ gözetleme: video yanıtı popup listesine düşer --- */
      const page = await context.newPage()
      await page.goto(`${media.base}/`)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).load())

      await expect
        .poll(
          () =>
            popup.evaluate(async () => {
              const { detected } = await chrome.storage.local.get('detected')
              return Object.values(detected || {})
                .flat()
                .map((i: any) => i.url)
            }),
          { timeout: 25000 }
        )
        .toContain(media.mediaUrl)

      // Popup, etkin sekmenin algılananlarını gösterir
      await page.bringToFront()
      await popup.evaluate(() => document.getElementById('refresh')?.click())
      await expect(popup.locator('#detected-list .det-name').first()).toContainText('ornek-video.mp4')

      /* --- 3. Popup'tan algılanan medyayı indir --- */
      const beforeDetectedDl = app.rpc.filter((m) => m.t === 'download-media').length
      await popup.evaluate(() => {
        const btn = document.querySelector('#detected-list li button') as HTMLButtonElement | null
        btn?.click()
      })
      await expect
        .poll(() => app.rpc.filter((m) => m.t === 'download-media').length, { timeout: 15000 })
        .toBeGreaterThan(beforeDetectedDl)
      const detectedDl = app.rpc.filter((m) => m.t === 'download-media').at(-1)
      expect(detectedDl?.url, 'algılanan medya adresi').toContain(media.mediaPath)

      // Gerçek köprü /rpc'de token + eklenti kökeni ister; aynı koşulları doğrula.
      const rpcRequest = app.requests.find((r) => r.url === '/rpc' && r.method === 'POST')
      expect(rpcRequest?.token, '/rpc token taşır').toBe(TEST_TOKEN)
      expect(rpcRequest?.origin, '/rpc eklenti kökeni taşır').toMatch(/^chrome-extension:\/\//)

      /* --- 4. Bağlantı tıklaması yakalanır, sayfa terk edilmez --- */
      const beforeClick = app.rpc.length
      await page.bringToFront()
      await page.locator('#dl').click()
      await expect.poll(() => app.rpc.length, { timeout: 15000 }).toBeGreaterThan(beforeClick)
      const clickRpc = app.rpc.at(-1)
      expect(clickRpc?.t, 'medya bağlantısı download-media olarak gider').toBe('download-media')
      expect(clickRpc?.url, 'tıklanan bağlantı adresi').toContain(media.mediaPath)
      expect(page.url(), 'sayfa indirme adresine gitmedi').toBe(`${media.base}/`)

      /* --- 5. Tarayıcı indirmesini devralma (IDM davranışı) --- */
      // İçerik betiği üst çerçevede çalışır; indirmeyi bir iframe içinden
      // başlatınca yakalama devreye girmez ve tarayıcı indirmesi oluşur.
      await page.goto(`${media.base}/`)
      await page.evaluate(() => {
        const f = document.createElement('iframe')
        f.id = 'dlframe'
        f.style.display = 'none'
        f.src = 'about:blank'
        document.body.appendChild(f)
      })
      const frame = page.frames().find((f) => f !== page.mainFrame())
      expect(frame, 'indirme çerçevesi').toBeTruthy()

      const beforeTakeover = app.rpc.filter((m) => m.t === 'download').length
      await frame!.evaluate((u) => {
        const a = document.createElement('a')
        a.href = u
        a.download = 'arsiv.bin'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
      }, `${media.base}${media.filePath}`)
      await expect
        .poll(() => app.rpc.filter((m) => m.t === 'download').length, { timeout: 20000 })
        .toBeGreaterThan(beforeTakeover)
      const taken = app.rpc.filter((m) => m.t === 'download').at(-1)
      expect(taken?.url, 'devralınan indirme adresi').toContain(media.filePath)

      /* --- 6. Yüzen panel: oynayan video uygulamaya bildirilir --- */
      const mediaPage = await context.newPage()
      await mediaPage.goto(`${media.base}/`)
      await expect
        .poll(() => mediaPage.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await mediaPage.bringToFront()
      await mediaPage.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement
        v.dispatchEvent(new Event('play', { bubbles: true }))
      })

      await expect
        .poll(() => app.wsMessages.filter((m) => m.t === 'float' && m.state === 'show').length, {
          timeout: 20000
        })
        .toBeGreaterThan(0)
      const floatMsg = app.wsMessages.filter((m) => m.t === 'float' && m.state === 'show').at(-1)
      expect(floatMsg?.media?.url).toContain(media.mediaPath)
      expect(floatMsg?.media?.kind).toBe('video')
      expect(floatMsg?.rect?.width).toBeGreaterThan(10)
      expect(floatMsg?.rect?.height).toBeGreaterThan(10)

      /* --- 6b. Sabit başlık videoyu örtse de rozet videonun üstünde kalır --- */
      const beforeSticky = app.wsMessages.filter((m) => m.t === 'float' && m.state === 'show').length
      const sticky = await context.newPage()
      await sticky.goto(`${media.base}/sticky`)
      await expect
        .poll(() => sticky.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await sticky.bringToFront()
      await sticky.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement
        v.dispatchEvent(new Event('play', { bubbles: true }))
      })
      await expect
        .poll(() => app.wsMessages.filter((m) => m.t === 'float' && m.state === 'show').length, {
          timeout: 20000
        })
        .toBeGreaterThan(beforeSticky)

      const stickyMsg = app.wsMessages.filter((m) => m.t === 'float' && m.state === 'show').at(-1)
      expect(stickyMsg?.media?.url, 'yapışkan sayfadaki video').toContain(media.mediaPath)
      // Ekran dikdörtgeni, sayfanın kendi görünüm koordinatlarına çevrilir.
      const originY = await sticky.evaluate(
        () => window.screenY + Math.max(0, window.outerHeight - window.innerHeight)
      )
      const stickyTop = (stickyMsg?.rect?.y ?? 0) - originY
      expect(stickyTop, 'rozet 64 px başlığın altında başlar').toBeGreaterThanOrEqual(64)
      expect(stickyTop, 'rozet videonun içinde kalır').toBeLessThan(64 + 40)

      /* --- 6c. Kaydırma rozeti sürüklemez; video çıkınca panel gizlenir --- */
      const scrollPage = await context.newPage()
      await scrollPage.goto(`${media.base}/scroll`)
      await expect
        .poll(() => scrollPage.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await scrollPage.bringToFront()

      const showCount = () =>
        app.wsMessages.filter(
          (m) => m.t === 'float' && m.state === 'show' && String(m.key).includes('/scroll')
        )
      const showsBefore = showCount().length
      await scrollPage.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement
        v.dispatchEvent(new Event('play', { bubbles: true }))
      })
      await expect.poll(() => showCount().length, { timeout: 20000 }).toBeGreaterThan(showsBefore)

      const placed = showCount().at(-1)
      const placedY = placed?.rect?.y ?? -1
      expect(placedY, 'rozet ekranda bir konuma yerleşti').toBeGreaterThan(0)

      // 120 px kaydır: rozet aynı ekran noktasında kalmalı.
      await scrollPage.evaluate(() => window.scrollTo(0, 120))
      await scrollPage.waitForTimeout(1500)
      const movedY = showCount().some((m) => Math.abs((m.rect?.y ?? -999) - placedY) > 2)
      expect(movedY, 'kaydırma rozeti sürüklemez').toBe(false)

      // Video tamamen ekrandan çıkınca panel gizlenmeli.
      const hidesBefore = app.wsMessages.filter((m) => m.t === 'float' && m.state === 'hide').length
      await scrollPage.evaluate(() => window.scrollTo(0, 1600))
      await expect
        .poll(
          () => app.wsMessages.filter((m) => m.t === 'float' && m.state === 'hide').length,
          { timeout: 15000 }
        )
        .toBeGreaterThan(hidesBefore)

      /* --- 6d. Akış sayfasında rozet, gönderi adresini bildirir --- */
      // Instagram akışı gibi: oynatıcı blob: kullanır, sayfa adresi tek bir
      // video değildir. Rozet, videonun yanındaki gönderi bağlantısını
      // (…/reel/…) sayfa adresi olarak bildirmeli; yt-dlp bunu çözebilir.
      const feedPage = await context.newPage()
      await feedPage.goto(`${media.base}/feed`)
      await expect
        .poll(() => feedPage.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await feedPage.bringToFront()

      await feedPage.waitForFunction(
        () => (document.getElementById('v') as HTMLVideoElement).src.startsWith('blob:'),
        undefined,
        { timeout: 20000 }
      )
      await feedPage.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement
        v.dispatchEvent(new Event('play', { bubbles: true }))
      })

      const feedShow = () =>
        app.wsMessages.find(
          (m) =>
            m.t === 'float' &&
            m.state === 'show' &&
            /\/reel\/CxYz7890\/$/.test(String(m.media?.pageUrl || ''))
        )
      await expect.poll(feedShow, { timeout: 20000 }).toBeTruthy()
      const feedMedia = feedShow()?.media
      expect(String(feedMedia?.url || ''), 'oynatıcı blob: adresi').toMatch(/^blob:/)
      expect(feedMedia?.sources?.length ?? 0, 'blob akışta <source> yok').toBe(0)
      await feedPage.close()

      /* --- 7. IDMS'i aç + eşleşmeyi kaldır --- */
      const beforeOpen = app.rpc.filter((m) => m.t === 'open-app').length
      await popup.evaluate(() => (document.getElementById('open-app') as HTMLButtonElement).click())
      await expect
        .poll(() => app.rpc.filter((m) => m.t === 'open-app').length, { timeout: 15000 })
        .toBeGreaterThan(beforeOpen)

      await popup.evaluate(() => (document.getElementById('unpair') as HTMLButtonElement).click())
      await expect(popup.locator('#pair-panel')).toBeVisible({ timeout: 15000 })
    } finally {
      await media.close()
      await app.close()
    }
  })
})

test.describe('Gecko — paketleme', () => {
  test('Firefox eklentisi statik olarak paketlenebilir', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'gecko-extension', 'yalnızca gecko projesi')
    // Playwright'un Firefox sürümü imzasız eklenti yükleyemez; yapı + manifest
    // doğrulaması yeterli (canlı akış Chromium tarafında test edilir).
    expect(validateManifest('gecko')).toEqual([])
    const mf = readMf('gecko')
    expect(mf.browser_specific_settings.gecko.id).toBe('idms2@idms2.app')
    const size = statSync(join(dirOf('gecko'), 'background.js')).size
    expect(size).toBeGreaterThan(1000)
  })
})
