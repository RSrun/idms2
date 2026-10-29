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
    expect(mf.version).toBe('1.2.1')
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

test.describe('İçerik betiği — yüzen panel', () => {
  test('panel sayfanın içinde çizilir; video bitince ve sekme gizlenince kalkar', async ({
    page
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-extension', 'yalnızca chromium projesi')

    // İçerik betiğini eklentinin kendi dünyasından bağımsız çalıştır: panelin
    // sayfada (gölge DOM'da) çizildiğini doğrudan gözleyebilelim.
    await page.setContent(
      `<video id="v" src="https://ornek.test/video.mp4"
         style="display:block;width:480px;height:270px"></video>`
    )
    await page.evaluate(() => {
      const w = window as any
      w.__msgs = []
      w.browser = { runtime: { sendMessage: (m: any) => (w.__msgs.push(m), undefined) } }
    })
    await page.addScriptTag({ content: readFileSync(join(sharedDir, 'content.js'), 'utf8') })

    await page.evaluate(() => {
      document.getElementById('v')!.dispatchEvent(new Event('play', { bubbles: true }))
    })

    // Rozet sayfanın içindedir: ayrı pencere yok; videonun sağ üst köşesinde
    // sabit durur.
    const pill = page.locator('#idms-float-host .pill')
    await expect(pill).toBeVisible()
    const panelBox = await pill.boundingBox()
    const videoBox = await page.locator('#v').boundingBox()
    expect(panelBox!.x + panelBox!.width, 'rozet videonun sağ üstünde').toBeGreaterThan(
      videoBox!.x + videoBox!.width - 30
    )
    expect(panelBox!.y, 'rozet videonun sağ üstünde').toBeLessThan(videoBox!.y + 30)
    expect(panelBox!.y, 'rozet videonun içinde').toBeGreaterThanOrEqual(videoBox!.y)

    // Kalite listesi uygulamaya sorulur; panel uygulamada değil sayfada çizilir.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__msgs.filter((m: any) => m.type === 'float-formats').length
        )
      )
      .toBeGreaterThan(0)
    const asked = await page.evaluate(() =>
      (window as any).__msgs.filter((m: any) => m.type === 'float-formats').at(-1)
    )
    expect(asked.media.url).toContain('video.mp4')

    // Video "boşaldı": rozet hemen kalkar (masaüstünde bekleyen bir pencere yok).
    await page.evaluate(() => {
      document.getElementById('v')!.dispatchEvent(new Event('emptied', { bubbles: true }))
    })
    await expect(pill).toBeHidden()

    // Sekme gizlenince panel kalkar; sayfa geri gelince yeniden görünür.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.locator('#idms-float-host .panel')).toBeHidden()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // Sekmeye dönüp video yeniden oynatılınca panel geri gelir.
    await page.evaluate(() => {
      document.getElementById('v')!.dispatchEvent(new Event('play', { bubbles: true }))
    })
    await expect(pill).toBeVisible()
  })

  test('kaydırma sırasında panel gizlenir, durunca videonun köşesinde döner', async ({
    page
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-extension', 'yalnızca chromium projesi')

    await page.setContent(
      `<video id="v" src="https://ornek.test/video.mp4"
         style="display:block;width:480px;height:270px"></video>
       <div id="tall" style="height:2000px"></div>`
    )
    await page.evaluate(() => {
      const w = window as any
      w.browser = { runtime: { sendMessage: (m: any) => (w.__msgs.push(m), undefined) } }
      w.__msgs = []
    })
    await page.addScriptTag({ content: readFileSync(join(sharedDir, 'content.js'), 'utf8') })
    await page.evaluate(() => {
      document.getElementById('v')!.dispatchEvent(new Event('play', { bubbles: true }))
    })

    const pill = page.locator('#idms-float-host .pill')
    await expect(pill).toBeVisible()

    // Kaydırma başlar: panel hemen gizlenir.
    await page.evaluate(() => window.scrollTo(0, 80))
    await expect(pill).toBeHidden({ timeout: 2000 })

    // Kaydırma durunca videonun görünen sağ üst köşesinde geri gelir
    // (video üst kenarı ekrandan çıktığı için rozet görünümün üst sınırına yaslanır).
    await expect(pill).toBeVisible({ timeout: 5000 })
    const after = await pill.boundingBox()
    expect(after, 'panel geri geldi').toBeTruthy()
    expect(after!.y, 'rozet görünür sağ üst köşede').toBeGreaterThanOrEqual(11)
    expect(after!.y, 'rozet görünür sağ üst köşede').toBeLessThanOrEqual(13)
  })

  test('rozet tıklanınca kalite kartı açılır, satır indirmeyi tetikler', async ({
    page
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-extension', 'yalnızca chromium projesi')

    await page.setContent(
      `<video id="v" src="https://ornek.test/video.mp4"
         style="display:block;width:640px;height:360px"></video>`
    )
    // Sahte eklenti API'si içerik betiğinden ÖNCE kurulmalı: betik yüklenirken
    // `browser`/`chrome` nesnesini seçiyor.
    await page.evaluate(() => {
      const w = window as any
      w.__msgs = []
      w.browser = {
        runtime: {
          sendMessage: (m: any) => {
            w.__msgs.push(m)
            if (m.type === 'float-formats') {
              return Promise.resolve({
                ok: true,
                language: 'tr',
                formats: [
                  { formatId: 'src:0', kind: 'video', label: '720p', detail: 'MP4', best: true },
                  { formatId: 'src:1', kind: 'audio', label: 'M4A', detail: '128 kbps' }
                ]
              })
            }
            if (m.type === 'float-download') {
              return Promise.resolve({ ok: true, message: 'IDMS kuyruğuna eklendi' })
            }
            return Promise.resolve({ ok: true })
          }
        }
      }
    })
    await page.addScriptTag({ content: readFileSync(join(sharedDir, 'content.js'), 'utf8') })
    await page.evaluate(() => {
      document.getElementById('v')!.dispatchEvent(new Event('play', { bubbles: true }))
    })

    const pill = page.locator('#idms-float-host .pill')
    await expect(pill).toBeVisible()
    await pill.click()

    const card = page.locator('#idms-float-host .card')
    await expect(card).toBeVisible()
    const row = page.locator('#idms-float-host .row').first()
    await expect(row).toContainText('720p')
    await expect(page.locator('#idms-float-host .sec').first()).toContainText('Video')

    await row.click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__msgs.filter((m: any) => m.type === 'float-download').length
        )
      )
      .toBeGreaterThan(0)
    const dl = await page.evaluate(() =>
      (window as any).__msgs.filter((m: any) => m.type === 'float-download').at(-1)
    )
    expect(dl.formatId).toBe('src:0')
    expect(dl.kind).toBe('video')
    await expect(page.locator('#idms-float-host .status')).toContainText('IDMS kuyruğuna eklendi')
  })

  test('Instagram /reels/{kod}/ adresini tek video sayar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-extension', 'yalnızca chromium projesi')

    // Instagram'da bir reel açılınca adres /reels/{kod}/ olur. Bu yol liste
    // sayfası sanılırsa panel "bu sayfa tek bir video değil" notu gösterir.
    await page.route('**/reels/CxYz7890/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<video id="v" src="https://ornek.test/video.mp4"
                 style="display:block;width:480px;height:270px"></video>`
      })
    )
    await page.goto('http://idms.test/reels/CxYz7890/')
    await page.evaluate(() => {
      const w = window as any
      w.__msgs = []
      w.browser = { runtime: { sendMessage: (m: any) => (w.__msgs.push(m), undefined) } }
    })
    await page.addScriptTag({ content: readFileSync(join(sharedDir, 'content.js'), 'utf8') })

    await page.evaluate(() => {
      document.getElementById('v')!.dispatchEvent(new Event('play', { bubbles: true }))
    })
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__msgs.filter((m: any) => m.type === 'float-formats').length
        )
      )
      .toBeGreaterThan(0)

    const asked = await page.evaluate(() =>
      (window as any).__msgs.filter((m: any) => m.type === 'float-formats').at(-1)
    )
    expect(asked.media.pageUrl, 'reel adresi korunur').toBe('http://idms.test/reels/CxYz7890/')
  })
})

/**
 * İçerik betiğini sahte eklenti API'siyle sayfaya enjekte eder. `paired`
 * değeri `chrome.storage.local` yanıtını taklit eder: içerik betiği IDMS
 * hazır değilken indirme bağlantısını durdurmamalıdır.
 */
async function injectLinkCapture(
  page: import('@playwright/test').Page,
  opts: { paired: boolean; reply?: any }
): Promise<void> {
  await page.evaluate(
    ({ paired, reply }) => {
      const w = window as any
      w.__msgs = []
      w.browser = {
        storage: {
          local: {
            get: async () => ({ floatingPanel: true, paired, enabled: true })
          },
          onChanged: { addListener: () => undefined }
        },
        runtime: {
          sendMessage: (m: any) => {
            w.__msgs.push(m)
            return Promise.resolve(reply)
          }
        }
      }
    },
    { paired: opts.paired, reply: opts.reply ?? { ok: true, message: 'IDMS kuyruğuna eklendi' } }
  )
  await page.addScriptTag({ content: readFileSync(join(sharedDir, 'content.js'), 'utf8') })
  // `storage.local.get` çözülene kadar bekle (applyConfig).
  await page.waitForTimeout(150)
}

test.describe('İçerik betiği — bağlantı yakalama', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-extension', 'yalnızca chromium projesi')
    await page.route('**/files/arsiv.zip', (route) =>
      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="arsiv.zip"',
          'Content-Length': '256'
        },
        body: Buffer.alloc(256)
      })
    )
    await page.setContent(`
      <a id="zip" href="http://idms.test/files/arsiv.zip" download="arsiv.zip">zip</a>
      <a id="plain" href="http://idms.test/files/arsiv.zip">düz bağlantı</a>
    `)
  })

  test('eşleştirme yokken tıklama tarayıcıya bırakılır, yutulmaz', async ({ page }) => {
    await injectLinkCapture(page, { paired: false })

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.click('#zip')
    ])
    expect(download.suggestedFilename(), 'tarayıcı indirdi').toBe('arsiv.zip')
    expect(
      await page.evaluate(() => (window as any).__msgs.length),
      'IDMS’e mesaj gönderilmedi'
    ).toBe(0)
    await expect(page.locator('#idms-toast-host .idms-toast')).toContainText('tarayıcıya bırakıldı')
  })

  test('eşleşmişken tıklama IDMS’e gider, sayfa terk edilmez', async ({ page }) => {
    await injectLinkCapture(page, { paired: true })

    await page.click('#zip')
    await expect
      .poll(() => page.evaluate(() => (window as any).__msgs.length))
      .toBe(1)
    const msg = await page.evaluate(() => (window as any).__msgs[0])
    expect(msg.type).toBe('link-click')
    expect(msg.url).toContain('/files/arsiv.zip')
    expect(msg.media).toBe(false)
    expect(page.url(), 'sayfa indirme adresine gitmedi').toContain('about:blank')
    await expect(page.locator('#idms-toast-host .idms-toast')).toContainText(
      'İndirme IDMS kuyruğuna eklendi'
    )
  })

  test('IDMS yanıt vermezse tıklama tarayıcı indirmesine geri bırakılır', async ({ page }) => {
    await injectLinkCapture(page, { paired: true, reply: { ok: false, error: 'IDMS çalışmıyor' } })

    // `download` öznitelikli bağlantı: geri dönüş, tarayıcının indirme
    // davranışını koruyan geçici bir bağlantıyla yapılır. Bu tıklama içerik
    // betiği tarafından yeniden yakalanmamalı (mesaj sayısı 1 kalmalı).
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.click('#zip')
    ])
    expect(download.suggestedFilename(), 'geri dönüş indirmesi').toBe('arsiv.zip')
    await expect(page.locator('#idms-toast-host .idms-toast')).toContainText(
      'IDMS çalışmıyor'
    )
    expect(
      await page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === 'link-click').length),
      'yakalama yalnızca bir kez denendi'
    ).toBe(1)
  })
})

/** Sahte IDMS uygulaması: gerçek köprü protokolü (HTTP /info /pair /rpc /status + WS). */
type Msg = Record<string, any>

const TEST_CODE = 'TEST01'
const TEST_TOKEN = 'test-token-0123456789abcdef0123456789'

async function startFakeApp() {
  const rpc: Msg[] = []
  const requests: Array<{ method: string; url: string; origin: string; token: string }> = []
  const wsOrigins: string[] = []
  let paired = false
  let port = 0
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
        port,
        needsPairing: true,
        paired,
        integration: true,
        floatingPanel: true
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
      json(200, { ok: true, token: TEST_TOKEN, port, app: 'IDMS', version: '1.0.0-test' })
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
          port,
          summary: { active: 0, queued: 0, totalSpeed: 0 },
          items: []
        })
        return
      }
      rpc.push(body)
      // Sayfa içi panel istekleri: kalite listesi ve indirme yanıtları.
      if (body?.t === 'float-formats') {
        json(200, {
          ok: true,
          replies: [
            {
              t: 'float-formats',
              ok: true,
              language: 'tr',
              formats: [
                { formatId: 'fake-720', kind: 'video', label: '720p', detail: 'MP4', best: true },
                { formatId: 'fake-audio', kind: 'audio', label: 'M4A', detail: '128 kbps' }
              ]
            }
          ]
        })
        return
      }
      if (body?.t === 'float-download') {
        json(200, {
          ok: true,
          replies: [{ t: 'float-download', ok: true, message: 'IDMS kuyruğuna eklendi' }]
        })
        return
      }
      json(200, { ok: true, id: `fake-${rpc.length}`, replies: [{ t: 'ack', ok: true }] })
      return
    }
    json(404, { error: 'bilinmeyen yol' })
  })
  // Portu işletim sistemi seçer: makinede çalışan gerçek IDMS ya da kullanıcının
  // eşleşmiş tarayıcı eklentisi test köprüsüne istek göndermesin. Test, bu portu
  // `storage.local` üzerinden eklentiye bildirir; `findApp` önce kayıtlı portu dener.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    wsOrigins.push(String(req.headers.origin || ''))
    markWs()
  })

  return {
    rpc,
    requests,
    wsOrigins,
    wsReady,
    get paired() {
      return paired
    },
    get port() {
      return port
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
    if (url.startsWith('/media/live.m3u8')) {
      // Yalnızca ağ gözetlemesinin gördüğü manifest: `no-store` yanıtı kaynak
      // zamanlamasına düşmez, arka plan akışı yakalayıp panele iletmelidir.
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store'
      })
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
          'low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
          'high.m3u8'
        ].join('\n')
      )
      return
    }
    if (url.startsWith('/media/master.m3u8')) {
      // Oynatıcının arka planda indirdiği HLS manifesti (Reddit'in
      // packaged-media akışı gibi). Kaliteler burada listelenir.
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl'
      })
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
          'low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
          'high.m3u8'
        ].join('\n')
      )
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
    if (url.startsWith('/reels/CxYz7890')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Reel</title>
        <style>
          html, body { margin: 0; padding: 0; }
          video { display: block; width: 480px; height: 270px; }
        </style></head>
        <body>
          <video id="v" preload="auto" autoplay muted loop controls></video>
          <script>
            fetch('${mediaPath}')
              .then((r) => r.blob())
              .then((b) => { document.getElementById('v').src = URL.createObjectURL(b) })
          <\/script>
        </body></html>`)
      return
    }
    if (url.startsWith('/shadow')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Gölge oynatıcı</title>
        <style>
          html, body { margin: 0; padding: 0; }
          #wrap { padding: 8px; }
          player-shell { display: block; width: 480px; height: 270px; }
        </style></head>
        <body>
          <article id="wrap">
            <a id="post" href="/r/test/comments/abc123/">gönderi</a>
            <player-shell id="shell">
              <template shadowrootmode="open">
                <style>video { display: block; width: 480px; height: 270px; }</style>
                <video id="v" src="${mediaPath}" preload="auto" muted loop controls></video>
              </template>
            </player-shell>
          </article>
          <script>
            // Oynatıcı kaliteleri gizli bir HLS manifestinden alır; panel bu
            // adresi kaynak zamanlamasından bulup yt-dlp'ye çözdürmeli.
            fetch('/media/master.m3u8').catch(() => {})
          <\/script>
        </body></html>`)
      return
    }
    if (url.startsWith('/net-shadow')) {
      // Aynı gölge oynatıcı; manifest yanıtı `no-store` olduğu için kaynak
      // zamanlamasında yok. Adres yalnızca eklentinin ağ gözetlemesinden gelir.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Ağ oynatıcı</title>
        <style>
          html, body { margin: 0; padding: 0; }
          player-shell { display: block; width: 480px; height: 270px; }
        </style></head>
        <body>
          <article>
            <a id="post" href="/r/test/comments/net123/">gönderi</a>
            <player-shell id="shell">
              <template shadowrootmode="open">
                <style>video { display: block; width: 480px; height: 270px; }</style>
                <video id="v" src="${mediaPath}" preload="auto" muted loop controls></video>
              </template>
            </player-shell>
          </article>
          <script>
            fetch('/media/live.m3u8').catch(() => {})
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
    expect(manifest.version).toBe('1.2.1')
    expect(manifest.manifest_version).toBe(3)

    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html`)
    await expect(popup.locator('header')).toBeVisible()

    // Makinede çalışan bir IDMS olabilir (geliştirme ortamı): durum metni
    // "Uygulama kapalı" ya da "Eşleştirme gerekli" olur. Asıl kural, uygulama
    // kapalıyken de eşleştirme kodunun görünür ve alanın kullanılabilir olması.
    await expect(popup.locator('#status-text')).toContainText(
      /Uygulama kapalı|Eşleştirme gerekli/
    )
    await expect(popup.locator('#pair-panel')).toBeVisible()
    await expect(popup.locator('#pair-code')).toBeVisible()

    if ((await popup.locator('#status-text').textContent())?.includes('Uygulama kapalı')) {
      await expect(popup.locator('#pair-code')).toBeDisabled()
      await expect(popup.locator('#pair-offline')).toBeVisible()
      await expect(popup.locator('#pair-btn')).toBeDisabled()
    }
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
      // Test köprüsü boş bir portta dinliyor olabilir (makinede gerçek IDMS
      // varsa 9789 doludur): ilk port taraması bittikten sonra kayıtlı portu
      // ona yönlendir.
      const sw = context.serviceWorkers()[0]
      await popup.waitForTimeout(1200)
      await sw.evaluate((p) => chrome.storage.local.set({ port: p }), app.port)
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

      /* --- 6. Sayfa içi yüzen panel: rozet ve kalite kartı --- */
      // Panel artık ayrı bir masaüstü penceresi değil, içerik betiğinin sayfaya
      // çizdiği gölge DOM düğümüdür; yalnızca bu sekmede yaşar.
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

      /** Belirli bir sayfadan gelen panel istekleri (içerik anahtarı sayfa adresiyle başlar). */
      const askedOn = (part: string) =>
        app.rpc.filter(
          (m) =>
            m.t === 'float-formats' && String(m.key || '').startsWith(`${media.base}${part}|`)
        )

      const pill = mediaPage.locator('#idms-float-host .pill')
      await expect(pill).toBeVisible({ timeout: 20000 })
      await expect.poll(() => askedOn('/').length, { timeout: 20000 }).toBeGreaterThan(0)
      const floatMsg = askedOn('/').at(-1)
      expect(floatMsg?.media?.url).toContain(media.mediaPath)
      expect(floatMsg?.media?.kind).toBe('video')

      // Rozet videonun sağ üst köşesine sabitlenir.
      const pillBox = await pill.boundingBox()
      const videoBox = await mediaPage.locator('#v').boundingBox()
      expect(pillBox!.x + pillBox!.width, 'rozet videonun sağ üstünde').toBeGreaterThan(
        videoBox!.x + videoBox!.width - 30
      )
      expect(pillBox!.y, 'rozet videonun sağ üstünde').toBeLessThan(videoBox!.y + 30)

      // Rozete tıklanınca kart açılır; satırlar uygulamadan gelen listedir.
      await pill.click()
      const row = mediaPage.locator('#idms-float-host .row').first()
      await expect(row).toContainText('720p', { timeout: 20000 })
      await expect(mediaPage.locator('#idms-float-host .sec').first()).toContainText('Video')
      await row.click()
      await expect(mediaPage.locator('#idms-float-host .status')).toContainText(
        'IDMS kuyruğuna eklendi'
      )
      await expect
        .poll(() => app.rpc.filter((m) => m.t === 'float-download').length, { timeout: 15000 })
        .toBeGreaterThan(0)
      const floatDl = app.rpc.filter((m) => m.t === 'float-download').at(-1)
      expect(floatDl?.formatId).toBe('fake-720')
      expect(floatDl?.kind).toBe('video')

      /* --- 6b. Sabit başlık videoyu örtse de rozet başlığın altında kalır --- */
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

      const stickyPill = sticky.locator('#idms-float-host .pill')
      await expect(stickyPill).toBeVisible({ timeout: 20000 })
      await expect.poll(() => askedOn('/sticky').length, { timeout: 20000 }).toBeGreaterThan(0)
      expect(askedOn('/sticky').at(-1)?.media?.url, 'yapışkan sayfadaki video').toContain(
        media.mediaPath
      )
      // Sabit başlık videoyu örtse de rozet videonun sağ üst köşesinde durur.
      const stickyBox = await stickyPill.boundingBox()
      const stickyVideo = await sticky.locator('#v').boundingBox()
      expect(stickyBox!.y, 'rozet videonun sağ üstünde').toBeLessThan(stickyVideo!.y + 30)
      expect(stickyBox!.x + stickyBox!.width, 'rozet videonun sağ üstünde').toBeGreaterThan(
        stickyVideo!.x + stickyVideo!.width - 30
      )
      await sticky.close()

      /* --- 6c. Kaydırma rozeti videonun köşesinde tutar; video çıkınca gizlenir --- */
      const scrollPage = await context.newPage()
      await scrollPage.goto(`${media.base}/scroll`)
      await expect
        .poll(() => scrollPage.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await scrollPage.bringToFront()
      const scrollPill = scrollPage.locator('#idms-float-host .pill')
      await scrollPage.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement
        v.dispatchEvent(new Event('play', { bubbles: true }))
      })
      await expect(scrollPill).toBeVisible({ timeout: 20000 })
      const placedY = (await scrollPill.boundingBox())!.y
      expect(placedY, 'rozet videonun sağ üstünde').toBeLessThan(60)

      // 120 px kaydır: kaydırma sırasında panel gizlenir, durunca videonun
      // görünen sağ üst köşesinde geri gelir.
      await scrollPage.evaluate(() => window.scrollTo(0, 120))
      await expect(scrollPill).toBeHidden({ timeout: 2000 })
      await expect(scrollPill).toBeVisible({ timeout: 5000 })
      const movedY = (await scrollPill.boundingBox())?.y ?? -1
      expect(Math.abs(movedY - placedY), 'kaydırma rozeti videodan koparmaz').toBeLessThanOrEqual(1)

      // Video tamamen ekrandan çıkınca panel gizlenir.
      await scrollPage.evaluate(() => window.scrollTo(0, 1600))
      await expect(scrollPill).toBeHidden({ timeout: 15000 })
      await scrollPage.close()

      /* --- 6d. Akış sayfasında panel, gönderi adresini bildirir --- */
      // Instagram akışı gibi: oynatıcı blob: kullanır, sayfa adresi tek bir
      // video değildir. Panel, videonun yanındaki gönderi bağlantısını
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

      const feedAsked = () =>
        app.rpc.filter(
          (m) =>
            m.t === 'float-formats' &&
            /\/reel\/CxYz7890\/$/.test(String(m.media?.pageUrl || ''))
        )
      await expect.poll(() => feedAsked().length, { timeout: 20000 }).toBeGreaterThan(0)
      const feedMedia = feedAsked().at(-1)?.media
      expect(String(feedMedia?.url || ''), 'oynatıcı blob: adresi').toMatch(/^blob:/)
      expect(feedMedia?.sources?.length ?? 0, 'blob akışta <source> yok').toBe(0)
      await feedPage.close()

      /* --- 6e. Instagram /reels/{kod}/ adresi tek bir video sayılır --- */
      // Instagram bir reel açılınca adres /reels/{kod}/ olur; bu yol liste
      // sayfası sanılırsa panel "bu sayfa tek bir video değil" notu gösterir.
      const reelPage = await context.newPage()
      await reelPage.goto(`${media.base}/reels/CxYz7890/`)
      await expect
        .poll(() => reelPage.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await reelPage.bringToFront()
      await reelPage.waitForFunction(
        () => (document.getElementById('v') as HTMLVideoElement).src.startsWith('blob:'),
        undefined,
        { timeout: 20000 }
      )
      await reelPage.evaluate(() => {
        const v = document.getElementById('v') as HTMLVideoElement
        v.dispatchEvent(new Event('play', { bubbles: true }))
      })

      const reelAsked = () =>
        app.rpc.filter(
          (m) =>
            m.t === 'float-formats' &&
            String(m.media?.pageUrl || '').endsWith('/reels/CxYz7890/')
        )
      await expect.poll(() => reelAsked().length, { timeout: 20000 }).toBeGreaterThan(0)
      expect(String(reelAsked().at(-1)?.media?.pageUrl || ''), 'reel sayfası adresi korunur').toBe(
        `${media.base}/reels/CxYz7890/`
      )
      await reelPage.close()

      /* --- 6f. Gölge DOM (Reddit) içindeki oynatıcı --- */
      // Reddit videosu <shreddit-player> gibi bir kabuğun açık gölge kökünde
      // durur: belge ağacında görünmez, play olayı belgeye ulaşmaz. İşaretçi
      // olayı kabuktan gelir; panel yine de videoyu bulup çözmelidir.
      const shadowPage = await context.newPage()
      await shadowPage.goto(`${media.base}/shadow`)
      await expect
        .poll(() => shadowPage.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await shadowPage.bringToFront()
      await shadowPage.waitForTimeout(400)

      const box = await shadowPage.evaluate(() => {
        const r = document.getElementById('shell')!.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await shadowPage.mouse.move(box.x, box.y)

      await expect.poll(() => askedOn('/shadow').length, { timeout: 20000 }).toBeGreaterThan(0)
      const shadowMedia = askedOn('/shadow').at(-1)?.media
      expect(String(shadowMedia?.url || ''), 'gölge kökündeki video').toContain(media.mediaPath)
      expect(String(shadowMedia?.pageUrl || ''), 'gölge sınırı aşılıp gönderi bulunur').toContain(
        '/r/test/comments/abc123/'
      )
      expect(String(shadowMedia?.manifest || ''), 'oynatıcının HLS manifesti bulunur').toContain(
        '/media/master.m3u8'
      )
      const shadowPill = shadowPage.locator('#idms-float-host .pill')
      await expect(shadowPill).toBeVisible({ timeout: 15000 })
      const shadowPillBox = await shadowPill.boundingBox()
      const shellBox = await shadowPage.evaluate(() => {
        const r = document.getElementById('shell')!.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right }
      })
      expect(shadowPillBox!.y, 'rozet videonun sağ üstünde').toBeLessThan(shellBox.y + 30)
      expect(shadowPillBox!.x + shadowPillBox!.width, 'rozet videonun sağ üstünde').toBeGreaterThan(
        shellBox.right - 30
      )
      await shadowPage.close()

      /* --- 6g. Manifest yalnızca ağ gözetlemesinde görünse de panele ulaşır --- */
      // Reddit'in oynatıcısı manifesti no-store ile/işçiden çekebilir; sayfa
      // kayıtlarında görünmez. Arka planın webRequest yakalaması yedektir.
      const netPage = await context.newPage()
      await netPage.goto(`${media.base}/net-shadow`)
      await expect
        .poll(() => netPage.evaluate(() => document.documentElement.dataset.idmsReady === '1'), {
          timeout: 20000
        })
        .toBe(true)
      await netPage.bringToFront()
      await netPage.waitForTimeout(600)
      const netBox = await netPage.evaluate(() => {
        const r = document.getElementById('shell')!.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await netPage.mouse.move(netBox.x, netBox.y)

      const netAsked = () =>
        app.rpc.filter(
          (m) =>
            m.t === 'float-formats' &&
            String(m.key || '').startsWith(`${media.base}/net-shadow|`) &&
            String(m.media?.manifest || '').includes('/media/live.m3u8')
        )
      await expect.poll(() => netAsked().length, { timeout: 25000 }).toBeGreaterThan(0)
      await netPage.close()


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