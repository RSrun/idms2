/**
 * İndirme motoru entegrasyon testleri.
 *
 * Node + esbuild ile derlenir (electron gerekmez):
 *   node scripts/test-engine.mjs
 *
 * Kapsam:
 *  - URL sorgulama (probe) + Range desteği
 *  - Çok segmentli indirme → SHA256 bütünlük doğrulaması
 *  - Duraklat → devam ettir (resume) → bütünlük
 *  - Kuyruk eşzamanlılığı (maxConcurrent)
 *  - Eklenti WS sunucusu: eşleştirme (hatalı/doğru kod), indirme isteği
 *  - Zamanlanmış indirme
 *  - Kuyruğa ekleme (queue)
 *  - Benzersiz yol + kategori tespiti yardımcıları
 */
import { createServer, request } from 'http'
import { createHash, randomBytes } from 'crypto'
import { spawnSync } from 'child_process'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { pickExistingOutput } from '../src/main/ytdlp'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Proje kökü: package.json'ı bulana kadar yukarı çık (bundle konumundan bağımsız) */
const root = (() => {
  let d = __dirname
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  return process.cwd()
})()
/** Windows ESM: mutlak yolları file:// URL'ine çevir */
const mod = (p) => pathToFileURL(p).href

let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(t) {
  console.log(`\n■ ${t}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Basit HTTP istemcisi (Origin başlığı serbestçe ayarlanabilsin). */
function httpJson(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: any } = {}
): Promise<{ status: number; headers: Record<string, any>; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const payload =
      opts.body === undefined
        ? null
        : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(opts.headers || {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: any = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            /* düz metin */
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, json, text })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/* ------------------------------------------------------------------ */
/* Test sunucusu: Range destekli statik dosya sunucusu               */
/* ------------------------------------------------------------------ */

const FILES = {
  '/big.bin': randomBytes(6 * 1024 * 1024), // 6 MB → 8 segment
  '/medium.bin': randomBytes(1536 * 1024), // 1.5 MB
  '/video.mp4': randomBytes(3 * 1024 * 1024), // video uzantısı → kategori testi
  '/master.m3u8': Buffer.from(
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
      'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      'high.m3u8'
    ].join('\n')
  ),
  '/small.txt': Buffer.from('hello idms2')
}

const requestLog = []

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const body = FILES[url.pathname]
  requestLog.push({ method: req.method, path: url.pathname, range: req.headers.range })

  if (!body) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  const size = body.length

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': size,
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes'
    })
    res.end()
    return
  }

  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    if (m) {
      const start = parseInt(m[1], 10)
      const end = m[2] ? parseInt(m[2], 10) : size - 1
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      const slice = body.subarray(start, end + 1)
      res.writeHead(206, {
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      })
      res.end(slice)
      return
    }
  }

  res.writeHead(200, {
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream'
  })
  res.end(body)
})

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function sha256File(path) {
  return sha256(readFileSync(path))
}

/* ------------------------------------------------------------------ */
/* Sahte Store (electron'suz)                                          */
/* ------------------------------------------------------------------ */

function makeSettings(over = {}) {
  return {
    general: {
      language: 'tr',
      theme: 'system',
      downloadDir: '',
      maxConcurrent: 3,
      segmentsPerDownload: 8,
      speedLimitMbps: 0,
      autoStart: true,
      confirmBeforeDownload: false,
      monitorClipboard: false,
      startOnBoot: false,
      startMinimized: false,
      ...over.general
    },
    notifications: {
      onStart: true,
      onProgress: true,
      onComplete: true,
      onError: true,
      systemToasts: false,
      inAppToasts: true,
      playSound: false
    },
    social: {
      ytdlpPath: '',
      ffmpegPath: '',
      passCookies: true,
      preferredQuality: 'best',
      impersonate: true
    },
    torrent: {
      saveDir: '',
      port: 0,
      maxConcurrent: 3,
      uploadLimitMbps: 0,
      seedRatioLimit: 2,
      dht: true,
      utp: true
    },
    extension: {
      port: 19789,
      pairingCode: 'TEST01',
      token: 'engine-test-token-0123456789abcdef0123456789abcdef',
      allowedOrigins: [],
      enabled: true,
      floatingPanel: true
    },
    ...over
  }
}

class FakeStore {
  constructor(settings) {
    this.settings = settings
    this.downloads = []
    this.saveCount = 0
  }
  getSettings() {
    return this.settings
  }
  patchSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      general: { ...this.settings.general, ...(patch.general || {}) },
      extension: { ...this.settings.extension, ...(patch.extension || {}) }
    }
    return this.settings
  }
  saveSettings() {}
  loadDownloads() {
    return this.downloads
  }
  saveDownloads(items) {
    this.downloads = items
    this.saveCount++
  }
  saveDownloadsNow(items) {
    this.downloads = items
    this.saveCount++
  }
}

/* ------------------------------------------------------------------ */
/* Ana test                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const outDir = join(tmpdir(), 'idms2-engine-tests')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  // Modülleri derlenmiş paketten al
  const { probeUrl, filenameFromDisposition, filenameFromUrl, sanitizeFilename } = await import(
    mod(join(root, 'tests', '.build', 'probe.mjs'))
  )
  const { DownloadManager, categoryForFilename, uniquePath } = await import(
    mod(join(root, 'tests', '.build', 'manager.mjs'))
  )
  const { ExtensionServer } = await import(mod(join(root, 'tests', '.build', 'extServer.mjs')))

  /* ---------------- 1. URL sorgulama ---------------- */
  section('1. URL sorgulama (probe)')

  const p1 = await probeUrl(`${base}/big.bin`)
  ok('dosya adı çıkar', p1.name === 'big.bin', p1.name)
  ok('boyut doğru', p1.sizeBytes === FILES['/big.bin'].length, `${p1.sizeBytes}`)
  ok('Range destekli', p1.supportsRange === true)
  ok('ok=true', p1.ok === true)

  const p2 = await probeUrl(`${base}/does-not-exist`)
  ok('404 yakalanır', p2.ok === false && /404/.test(p2.error || ''), p2.error)

  const p3 = await probeUrl('not-a-url')
  ok('geçersiz URL reddedilir', p3.ok === false)

  ok(
    'Content-Disposition adı',
    filenameFromDisposition('attachment; filename="dosya adi.zip"') === 'dosya adi.zip'
  )
  ok(
    'filename* (UTF-8) çözümü',
    filenameFromDisposition("attachment; filename*=UTF-8''video%20g%C3%B6r%C3%BCnt%C3%BC.mp4") ===
      'video görüntü.mp4'
  )
  ok('URL’den ad', filenameFromUrl('https://x.com/a/b/film.mp4?dl=1') === 'film.mp4')
  ok('geçersiz karakter temizliği', sanitizeFilename('a<b>c:d"e') === 'a_b_c_d_e')
  ok('uzun ad kırpılır', sanitizeFilename('x'.repeat(500) + '.bin').length <= 200)
  ok('kategori: video', categoryForFilename('film.mp4') === 'video')
  ok('kategori: arşiv', categoryForFilename('arsiv.7z') === 'archive')
  ok('kategori: program', categoryForFilename('kur.exe') === 'program')
  ok('kategori: bilinmeyen → other', categoryForFilename('veri.xyz') === 'other')

  /* ---------------- 2. Çok segmentli indirme ---------------- */
  section('2. Çok segmentli indirme (bütünlük)')

  const store = new FakeStore(makeSettings())
  store.getSettings().general.downloadDir = join(outDir, 'downloads')
  const mgr = new DownloadManager(store)

  const target1 = join(outDir, 'big.bin')
  const add1 = await mgr.add({ url: `${base}/big.bin`, savePath: target1, silent: true })
  ok('öğe eklendi', !!add1.id)
  ok('durum queued/downloading', ['queued', 'downloading', 'resolving'].includes(add1.state), add1.state)

  // Tamamlanana kadar bekle
  let deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const it = mgr.get(add1.id)
    if (it && (it.state === 'completed' || it.state === 'error')) break
    await sleep(120)
  }
  const done1 = mgr.get(add1.id)
  ok('tamamlandı', done1.state === 'completed', `${done1.state} ${done1.errorMessage || ''}`)
  ok('dosya oluştu', existsSync(target1))

  if (existsSync(target1)) {
    const got = sha256File(target1)
    const want = sha256(FILES['/big.bin'])
    ok('SHA256 eşleşiyor (segment yazımı)', got === want, `${got.slice(0, 12)} != ${want.slice(0, 12)}`)
    ok('boyut tam', readFileSync(target1).length === FILES['/big.bin'].length)
  }

  const segReqs = requestLog.filter((r) => r.path === '/big.bin' && r.method === 'GET')
  ok(
    'çoklu bağlantı kullanıldı (>1 GET)',
    segReqs.length > 1,
    `${segReqs.length} GET`
  )
  ok(
    'Range başlıkları gönderildi',
    segReqs.every((r) => !!r.range),
    `${segReqs.filter((r) => r.range).length}/${segReqs.length}`
  )

  /* ---------------- 3. Otomatik ad + kategori ---------------- */
  section('3. Otomatik ad ve kategori')

  const add2 = await mgr.add({ url: `${base}/video.mp4`, silent: true })
  await sleep(2500)
  const it2 = mgr.get(add2.id)
  ok('ad video.mp4', it2.name === 'video.mp4', it2.name)
  ok('kategori video', it2.category === 'video', it2.category)
  ok('kendi klasörüne yazıldı', it2.savePath.includes('video'), it2.savePath)

  // Bitmesini bekle
  deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const it = mgr.get(add2.id)
    if (it && (it.state === 'completed' || it.state === 'error')) break
    await sleep(120)
  }
  ok('video indirme tamam', mgr.get(add2.id).state === 'completed', mgr.get(add2.id).state)

  /* ---------------- 4. Aynı dosyaya iki kez ekleme ---------------- */
  section('4. Çakışan yol benzersizleştirilir')

  const p1path = uniquePath(target1)
  ok('var olan yol için (1) eklenir', /\(1\)/.test(p1path), p1path)
  const p2path = uniquePath(join(outDir, 'never.bin'))
  ok('olmayan yol aynen kalır', p2path === join(outDir, 'never.bin'))

  /* ---------------- 5. Eşzamanlılık sınırı ---------------- */
  section('5. Kuyruk eşzamanlılığı')

  const storeC = new FakeStore(makeSettings())
  storeC.getSettings().general.downloadDir = join(outDir, 'dl2')
  storeC.getSettings().general.maxConcurrent = 2
  const mgrC = new DownloadManager(storeC)

  const ids = []
  for (let i = 0; i < 5; i++) {
    const it = await mgrC.add({ url: `${base}/medium.bin`, silent: true })
    ids.push(it.id)
  }
  await sleep(900)
  const active = ids.filter((id) => mgrC.get(id).state === 'downloading').length
  ok('eşzamanlı ≤ 2', active <= 2, `${active} aktif`)
  ok('kuyrukta bekleyen var', ids.some((id) => mgrC.get(id).state !== 'downloading'))

  // Hepsi bitsin
  deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    const states = ids.map((id) => mgrC.get(id).state)
    if (states.every((s) => s === 'completed' || s === 'error')) break
    await sleep(200)
  }
  const finalStates = ids.map((id) => mgrC.get(id).state)
  ok(
    'hepsi tamamlandı',
    finalStates.every((s) => s === 'completed'),
    JSON.stringify(finalStates)
  )

  /* ---------------- 6. Duraklat / devam ---------------- */
  section('6. Duraklat → devam (resume)')

  // Hız sınırı altında yavaş akan ayrı bir yönetici: localhost'ta dosya
  // 500 ms içinde bitmesin diye
  const storeR = new FakeStore(makeSettings())
  storeR.getSettings().general.downloadDir = join(outDir, 'dl6')
  storeR.getSettings().general.speedLimitMbps = 2
  const mgrR = new DownloadManager(storeR)

  const target3 = join(outDir, 'resume.bin')
  const add3 = await mgrR.add({ url: `${base}/medium.bin`, savePath: target3, silent: true })
  await sleep(700)
  const mid = mgrR.get(add3.id)
  if (mid.state === 'downloading') {
    mgrR.pause(add3.id)
    const paused = mgrR.get(add3.id)
    ok('duraklatıldı', paused.state === 'paused', paused.state)
    ok('hız sıfırlandı', paused.progress.speed === 0)
    ok('ilerleme korundu', paused.progress.downloadedBytes > 0, `${paused.progress.downloadedBytes}`)
    const savedBytes = paused.progress.downloadedBytes

    await sleep(400)
    mgrR.resume(add3.id)
    deadline = Date.now() + 40000
    while (Date.now() < deadline) {
      const it = mgrR.get(add3.id)
      if (it.state === 'completed' || it.state === 'error') break
      await sleep(150)
    }
    const fin = mgrR.get(add3.id)
    ok('devam ettirip tamamladı', fin.state === 'completed', `${fin.state} ${fin.errorMessage || ''}`)
    ok('duraklatma anında ilerleme kaybolmadı', fin.progress.downloadedBytes >= savedBytes)
    if (existsSync(target3)) {
      ok(
        'resume sonrası SHA256',
        sha256File(target3) === sha256(FILES['/medium.bin']),
        `${sha256File(target3).slice(0, 12)} != ${sha256(FILES['/medium.bin']).slice(0, 12)}`
      )
    }
  } else {
    ok('duraklat testi (beklenen durum)', false, `state=${mid.state}`)
  }

  /* ---------------- 7. Kaldır + dosya silme ---------------- */
  section('7. Kaldırma')

  const add4 = await mgr.add({ url: `${base}/small.txt`, silent: true })
  await sleep(1500)
  const before = mgr.list().length
  mgr.remove(add4.id, true)
  ok('öğe listeden silindi', mgr.list().length === before - 1)

  /* ---------------- 8. Zamanlanmış indirme ---------------- */
  section('8. Zamanlama')

  const add5 = await mgr.add({ url: `${base}/small.txt`, silent: true, savePath: join(outDir, 'sch.txt') })
  mgr.schedule(add5.id, Date.now() + 60 * 60 * 1000)
  ok('durum scheduled', mgr.get(add5.id).state === 'scheduled')
  mgr.checkSchedules()
  ok('gelecek zaman sabit kalır', mgr.get(add5.id).state === 'scheduled')

  mgr.schedule(add5.id, Date.now() - 1000)
  mgr.checkSchedules()
  ok('geçmiş zaman kuyruğa alınır', mgr.get(add5.id).state !== 'scheduled', mgr.get(add5.id).state)

  // temizlik: küçük dosya bitsin diye bekle
  deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const it = mgr.get(add5.id)
    if (it.state === 'completed' || it.state === 'error') break
    await sleep(150)
  }

  /* ---------------- 9. Onay akışı ---------------- */
  section('9. İndirmeden önce onay (confirmBeforeDownload)')

  const store9 = new FakeStore(makeSettings())
  store9.getSettings().general.downloadDir = join(outDir, 'dl9')
  store9.getSettings().general.confirmBeforeDownload = true
  store9.getSettings().general.autoStart = true
  const mgr9 = new DownloadManager(store9)
  const add9 = await mgr9.add({ url: `${base}/small.txt`, silent: false })
  // Onay durumuna URL çözümlendikten sonra girer (probe "resolving")
  let waited = 0
  while (waited < 5000 && mgr9.get(add9.id).state !== 'confirming') {
    await sleep(100)
    waited += 100
  }
  ok('confirming durumunda bekler', mgr9.get(add9.id).state === 'confirming', mgr9.get(add9.id).state)
  await sleep(800)
  ok('otomatik başlamaz', mgr9.get(add9.id).state === 'confirming')
  mgr9.confirm(add9.id, undefined, true)
  ok('onay sonrası queued', mgr9.get(add9.id).state !== 'confirming', mgr9.get(add9.id).state)
  deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const it = mgr9.get(add9.id)
    if (it.state === 'completed' || it.state === 'error') break
    await sleep(150)
  }
  ok('onaydan sonra iner', mgr9.get(add9.id).state === 'completed', mgr9.get(add9.id).state)

  /* ---------------- 10. Eklenti WS sunucusu ---------------- */
  section('10. Tarayıcı eklentisi köprüsü (HTTP + WS)')

  // CJS paketi: ESM import'ta adlandırılmış dışa aktarım garanti değil
  const wsMod = await import(mod(join(root, 'node_modules', 'ws', 'index.js')))
  const WebSocket = wsMod.WebSocket || wsMod.default?.WebSocket || wsMod.default
  if (typeof WebSocket !== 'function') throw new Error('ws modülü yüklenemedi')

  const extStore = new FakeStore(makeSettings())
  extStore.getSettings().general.downloadDir = join(outDir, 'dl10')
  const mgrExt = new DownloadManager(extStore)

  /** Sayfa içi panelin uygulama tarafını taklit eder (pencere yok). */
  const floatCalls: any[] = []
  const floatBridge = {
    enabled: true,
    language: 'tr' as const,
    async formats(media: any, key?: string) {
      floatCalls.push({ type: 'formats', media, key })
      return {
        ok: true,
        formats: [
          {
            formatId: 'src:0',
            kind: 'video' as const,
            label: '720p',
            url: 'https://cdn.example.com/v-720.mp4'
          }
        ],
        language: 'tr' as const
      }
    },
    async download(media: any, kind: 'video' | 'audio', formatId?: string, key?: string) {
      floatCalls.push({ type: 'download', media, kind, formatId, key })
      return { ok: true, message: 'IDMS kuyruğuna eklendi' }
    },
    openFormats(media: any) {
      floatCalls.push({ type: 'openFormats', media })
    },
    showMainWindow() {
      floatCalls.push({ type: 'showMainWindow' })
    }
  }
  const ext = new ExtensionServer(extStore, mgrExt, undefined, floatBridge)
  const started = await ext.start()
  ok('sunucu başladı', started === true)
  ok('status.running', ext.status.running === true)
  ok('port atandı', ext.status.port > 0, String(ext.status.port))

  /* --- HTTP köprüsü: bilgi, CORS, eşleştirme, token --- */
  const EXT_ORIGIN = 'chrome-extension://idms-engine-test'
  const WEB_ORIGIN = 'https://evil.example'

  const infoRes = await httpJson(ext.status.port, 'GET', '/info', {
    headers: { Origin: EXT_ORIGIN }
  })
  ok(
    'HTTP /info eklenti kökenine açık',
    infoRes.status === 200 && infoRes.json?.app === 'IDMS',
    `${infoRes.status}`
  )
  ok('HTTP /info protokol 2', infoRes.json?.protocol === 2)
  ok(
    'HTTP /info CORS eklenti kökeni',
    infoRes.headers['access-control-allow-origin'] === EXT_ORIGIN
  )

  const preflightOk = await httpJson(ext.status.port, 'OPTIONS', '/pair', {
    headers: { Origin: EXT_ORIGIN, 'Access-Control-Request-Method': 'POST' }
  })
  ok('OPTIONS eklenti kökenine 204', preflightOk.status === 204, String(preflightOk.status))
  const preflightBad = await httpJson(ext.status.port, 'OPTIONS', '/pair', {
    headers: { Origin: WEB_ORIGIN, 'Access-Control-Request-Method': 'POST' }
  })
  ok('OPTIONS web kökenine 403', preflightBad.status === 403, String(preflightBad.status))
  ok('CORS web kökenine ACAO vermez', !preflightBad.headers['access-control-allow-origin'])

  const pairWeb = await httpJson(ext.status.port, 'POST', '/pair', {
    headers: { Origin: WEB_ORIGIN },
    body: { code: 'TEST01' }
  })
  ok('web kökeni eşleşemez', pairWeb.status === 403, String(pairWeb.status))

  const pairWrong = await httpJson(ext.status.port, 'POST', '/pair', {
    headers: { Origin: EXT_ORIGIN },
    body: { code: 'WRONG1' }
  })
  ok('hatalı kod 401', pairWrong.status === 401, String(pairWrong.status))
  ok('hatalı kodda paired=false', ext.status.paired === false)

  const pairOk = await httpJson(ext.status.port, 'POST', '/pair', {
    headers: { Origin: EXT_ORIGIN },
    body: { code: 'TEST01', client: 'EngineTest' }
  })
  const firstToken = String(pairOk.json?.token || '')
  ok('doğru kod token verir', pairOk.status === 200 && firstToken.length >= 32, `${pairOk.status}`)
  ok(
    'token yalnızca eklenti kökenine CORS',
    pairOk.headers['access-control-allow-origin'] === EXT_ORIGIN
  )
  ok(
    'eşleşen köken kaydedildi',
    extStore.getSettings().extension.allowedOrigins.includes(EXT_ORIGIN)
  )
  ok('status.paired = true', ext.status.paired === true)

  const whoami = await httpJson(ext.status.port, 'GET', '/whoami', {
    headers: { Origin: EXT_ORIGIN }
  })
  ok('whoami eşleşmiş kökeni bildirir', whoami.json?.paired === true && whoami.json?.knownExtension === true)

  const noToken = await httpJson(ext.status.port, 'POST', '/rpc', {
    headers: { Origin: EXT_ORIGIN },
    body: { t: 'ping' }
  })
  ok('tokensiz /rpc 401', noToken.status === 401, String(noToken.status))

  const badOrigin = await httpJson(ext.status.port, 'POST', '/rpc', {
    headers: { Origin: WEB_ORIGIN, 'X-IDMS-Token': firstToken },
    body: { t: 'ping' }
  })
  ok('yetkisiz köken tokenla bile 403', badOrigin.status === 403, String(badOrigin.status))

  const httpDl = await httpJson(ext.status.port, 'POST', '/rpc', {
    headers: { Origin: EXT_ORIGIN, 'X-IDMS-Token': firstToken },
    body: { t: 'download', url: `${base}/small.txt`, name: 'http-kucuk.txt' }
  })
  ok(
    'HTTP /rpc indirme kabul edildi',
    httpDl.status === 200 && httpDl.json?.ok === true,
    httpDl.text.slice(0, 120)
  )
  ok(
    'HTTP indirmesi yöneticiye eklendi',
    mgrExt.list().some((i) => i.url.endsWith('/small.txt'))
  )

  const statusRes = await httpJson(ext.status.port, 'GET', '/status', {
    headers: { Origin: EXT_ORIGIN, 'X-IDMS-Token': firstToken }
  })
  ok(
    'HTTP /status özet döner',
    statusRes.status === 200 && !!statusRes.json?.summary,
    String(statusRes.status)
  )

  const revoked = ext.revoke()
  ok(
    'revoke eşleştirmeyi sıfırlar',
    revoked.paired === false &&
      extStore.getSettings().extension.allowedOrigins.length === 0
  )
  const oldToken = await httpJson(ext.status.port, 'GET', '/status', {
    headers: { Origin: EXT_ORIGIN, 'X-IDMS-Token': firstToken }
  })
  ok('eski token geçersiz', oldToken.status === 401, String(oldToken.status))

  const pairAgain = await httpJson(ext.status.port, 'POST', '/pair', {
    headers: { Origin: EXT_ORIGIN },
    body: { code: 'TEST01' }
  })
  const token = String(pairAgain.json?.token || '')
  ok(
    'yeniden eşleşme yeni token verir',
    pairAgain.status === 200 && token.length >= 32 && token !== firstToken
  )
  const newToken = await httpJson(ext.status.port, 'GET', '/status', {
    headers: { Origin: EXT_ORIGIN, 'X-IDMS-Token': token }
  })
  ok(
    'yeni token çalışır',
    newToken.status === 200 && newToken.json?.paired === true,
    String(newToken.status)
  )

  // --- WS: token zorunlu; eşleştirme yalnızca HTTP /pair ile ---
  const wsStatus = (ws: any) =>
    new Promise<number>((res) => {
      ws.on('open', () => res(200))
      ws.on('unexpected-response', (_req: any, r: any) => res(r.statusCode || 0))
      ws.on('error', () => res(-1))
      setTimeout(() => res(-1), 3000)
    })

  const wsNoToken = new WebSocket(`ws://127.0.0.1:${ext.status.port}`)
  ok('tokensiz WS 401 ile reddedilir', (await wsStatus(wsNoToken)) === 401)
  try {
    wsNoToken.terminate()
  } catch {
    /* zaten kapalı */
  }

  const wsBadOrigin = new WebSocket(
    `ws://127.0.0.1:${ext.status.port}/?token=${encodeURIComponent(token)}`,
    { origin: WEB_ORIGIN }
  )
  ok('token olsa da eklenti dışı köken 403', (await wsStatus(wsBadOrigin)) === 403)
  try {
    wsBadOrigin.terminate()
  } catch {
    /* zaten kapalı */
  }

  // --- Token + eklenti kökeni: eşleşmiş istemci ---
  const ws2 = new WebSocket(
    `ws://127.0.0.1:${ext.status.port}/ws?token=${encodeURIComponent(token)}&client=Chrome&version=131.0`,
    { origin: EXT_ORIGIN }
  )
  const msgs2 = []
  ws2.on('message', (d) => msgs2.push(JSON.parse(d.toString())))
  await new Promise<void>((res, rej) => {
    ws2.on('error', rej)
    const iv = setInterval(() => {
      if (msgs2.some((m) => m.t === 'welcome' && m.paired)) {
        clearInterval(iv)
        res()
      }
    }, 50)
    setTimeout(() => {
      clearInterval(iv)
      res()
    }, 3000)
  })
  const welcome2 = msgs2.find((m) => m.t === 'welcome' && m.paired)
  ok('welcome geldi (token ile)', !!welcome2)
  ok('token ile paired=true', welcome2?.paired === true)
  ok(
    'welcome eşleştirme kodu sızdırmaz',
    msgs2.every((m) => m.pairingCode === undefined)
  )
  ok('sunucu tarafında paired sayıldı', ext.status.paired === true)
  ok('istemci listelendi', ext.status.clients.length === 1 && ext.status.clients[0].client === 'Chrome')

  // --- Sayfa içi yüzen panel köprüsü: eşleşme + eklenti kökeni gerekir ---
  const wsFloat = new WebSocket(
    `ws://127.0.0.1:${ext.status.port}/ws?token=${encodeURIComponent(token)}&client=FloatBrowser&version=1.2.0`,
    { origin: EXT_ORIGIN }
  )
  await new Promise<void>((res, rej) => {
    wsFloat.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.t === 'welcome' && m.paired === true) res()
    })
    wsFloat.on('error', rej)
    setTimeout(res, 2000)
  })

  const floatMedia = {
    url: 'https://cdn.example.com/v.mp4',
    pageUrl: 'https://example.com/watch',
    title: 'Örnek video',
    pageTitle: 'Örnek sayfa',
    kind: 'video',
    duration: 65,
    direct: true,
    sources: [
      { url: 'https://cdn.example.com/v-720.mp4', mime: 'video/mp4', label: '720p' },
      { url: 'javascript:alert(1)', label: 'kötü' }
    ],
    manifest: 'https://cdn.example.com/master.m3u8'
  }

  /** WS'ten bir istek gönderip eşleşen yanıtı bekler (panel HTTP /rpc ile aynı sözleşme). */
  const floatAsk = (msg: any, match: (m: any) => boolean, timeout = 3000) =>
    new Promise<any>((res) => {
      const h = (d: any) => {
        const m = JSON.parse(d.toString())
        if (match(m)) {
          wsFloat.off('message', h)
          res(m)
        }
      }
      wsFloat.on('message', h)
      wsFloat.send(JSON.stringify(msg))
      setTimeout(() => {
        wsFloat.off('message', h)
        res(null)
      }, timeout)
    })

  const fmt = await floatAsk(
    { t: 'float-formats', key: 'https://example.com/watch|VIDEO', reqId: 'r1', media: floatMedia },
    (m) => m.t === 'float-formats'
  )
  ok('panel kalite isteği yanıtlandı', !!fmt && fmt.ok === true && fmt.reqId === 'r1', JSON.stringify(fmt))
  ok('panel kaliteleri döndü', !!fmt && fmt.formats.length === 1 && fmt.formats[0].label === '720p')
  ok('panel dili döndü', !!fmt && fmt.language === 'tr', String(fmt?.language))

  const sentFormats = floatCalls.find((c) => c.type === 'formats')
  ok('panel medyası uygulamaya iletildi', !!sentFormats && sentFormats.media.url.endsWith('/v.mp4'))
  ok(
    'güvenli olmayan <source> atıldı',
    !!sentFormats &&
      sentFormats.media.sources.length === 1 &&
      sentFormats.media.sources[0].label === '720p',
    JSON.stringify(sentFormats?.media?.sources)
  )
  ok(
    'oynatıcının manifesti korundu',
    sentFormats?.media?.manifest === 'https://cdn.example.com/master.m3u8',
    String(sentFormats?.media?.manifest)
  )
  ok('panel anahtarı iletildi', sentFormats?.key === 'https://example.com/watch|VIDEO')

  const dlFmt = await floatAsk(
    {
      t: 'float-download',
      key: 'https://example.com/watch|VIDEO',
      reqId: 'd1',
      kind: 'video',
      formatId: 'src:0',
      media: floatMedia
    },
    (m) => m.t === 'float-download'
  )
  ok('panel indirme isteği yanıtlandı', !!dlFmt && dlFmt.ok === true && dlFmt.reqId === 'd1', JSON.stringify(dlFmt))
  const sentDl = floatCalls.find((c) => c.type === 'download')
  ok('indirilen satır iletildi', sentDl?.kind === 'video' && sentDl?.formatId === 'src:0')

  const act = await floatAsk(
    { t: 'float-action', action: 'formats', key: 'k', media: floatMedia },
    (m) => m.t === 'ack' && m.ref === 'float-action'
  )
  ok('panel eylemi yanıtlandı', !!act && act.ok === true, JSON.stringify(act))
  ok('Formatlar… ana pencereye yönlendirildi', floatCalls.some((c) => c.type === 'openFormats'))
  wsFloat.close()
  await sleep(150)

  // Eklenti dışı köken el sıkışmada (403) reddedildiği için panel isteği
  // gönderebilecek eşleşmiş bir web istemcisi yoktur; bu yüzden ayrı bir
  // "kökensiz panel isteği" senaryosu kurulmaz.

  // --- İndirme isteği ---
  const beforeDl = mgrExt.list().length
  ws2.send(JSON.stringify({ t: 'download', url: `${base}/small.txt`, name: 'küçük.txt' }))
  await sleep(700)
  ok('eklentiden indirme eklendi', mgrExt.list().length === beforeDl + 1)
  const fromExt = mgrExt.list()[0]
  ok('URL aktarıldı', fromExt.url.endsWith('/small.txt'), fromExt.url)

  // --- detect mesajı ---
  ws2.send(
    JSON.stringify({
      t: 'detect',
      page: { url: 'https://youtube.com/watch?v=x', title: 'Test Video' },
      items: [{ kind: 'video', url: 'https://x/v.mp4', title: 'Test Video', mime: 'video/mp4' }]
    })
  )
  const ack = await new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString())
      if (m.t === 'ack' && m.ref === 'detect') {
        ws2.off('message', h)
        res(m)
      }
    }
    ws2.on('message', h)
    setTimeout(() => res(null), 2500)
  })
  ok('detect ack alındi', ack && ack.ok === true, JSON.stringify(ack))

  // --- status yayınımı ---
  const statusMsg = await new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString())
      if (m.t === 'status') {
        ws2.off('message', h)
        res(m)
      }
    }
    ws2.on('message', h)
    ext.broadcastStatus()
    setTimeout(() => res(null), 2500)
  })
  ok('status yayınlandı', statusMsg && Array.isArray(statusMsg.items), JSON.stringify(statusMsg))

  ws2.close()
  await sleep(200)
  ok('bağlantı kapanınca client listesi boşalır', ext.status.clients.length === 0)
  await ext.stop()
  ok('sunucu durdu', ext.status.running === false)

  /* ---------------- 11. Kuyruğa ekle (queue) ---------------- */
  section('11. Kuyruğa ekle (queue)')

  // autoStart kapalı: queue() işi hemen başlatmaz (pompa tetiklenmez)
  const storeQ = new FakeStore(makeSettings({ general: { autoStart: false } }))
  storeQ.getSettings().general.downloadDir = join(outDir, 'dlq')
  const mgrQ = new DownloadManager(storeQ)
  const qa = await mgrQ.add({
    url: `${base}/small.txt`,
    totalBytes: FILES['/small.txt'].length,
    silent: true
  })
  ok('autoStart kapalı → kuyrukta', mgrQ.get(qa.id).state === 'queued', mgrQ.get(qa.id).state)
  mgrQ.queue(qa.id)
  await sleep(400)
  ok('queue() sonrası hemen başlamaz', mgrQ.get(qa.id).state === 'queued', mgrQ.get(qa.id).state)

  // scheduled → queued + scheduledAt kaldırılır
  mgrQ.schedule(qa.id, Date.now() + 3600 * 1000)
  ok('zamanlandı', mgrQ.get(qa.id).state === 'scheduled', mgrQ.get(qa.id).state)
  mgrQ.queue(qa.id)
  ok('scheduled → queued', mgrQ.get(qa.id).state === 'queued', mgrQ.get(qa.id).state)
  ok('scheduledAt kaldırıldı', !mgrQ.get(qa.id).scheduledAt)

  // error → queued + errorMessage temizlenir
  const itQ = mgrQ.get(qa.id)
  itQ.state = 'error'
  itQ.errorMessage = 'test hatası'
  mgrQ.queue(qa.id)
  ok(
    'error → queued + hata temizlendi',
    mgrQ.get(qa.id).state === 'queued' && !mgrQ.get(qa.id).errorMessage,
    mgrQ.get(qa.id).state
  )

  // completed → queue değişmez
  const storeQC = new FakeStore(makeSettings())
  storeQC.getSettings().general.downloadDir = join(outDir, 'dlqc')
  const mgrQC = new DownloadManager(storeQC)
  const qc = await mgrQC.add({ url: `${base}/small.txt`, silent: true })
  deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const it = mgrQC.get(qc.id)
    if (it.state === 'completed' || it.state === 'error') break
    await sleep(100)
  }
  ok('küçük dosya tamamlandı', mgrQC.get(qc.id).state === 'completed', mgrQC.get(qc.id).state)
  mgrQC.queue(qc.id)
  ok('completed korunur', mgrQC.get(qc.id).state === 'completed', mgrQC.get(qc.id).state)

  // downloading → queue: anında duraklatılıp kuyruğa alınır
  const storeQD = new FakeStore(makeSettings())
  storeQD.getSettings().general.downloadDir = join(outDir, 'dlqd')
  storeQD.getSettings().general.speedLimitMbps = 2
  const mgrQD = new DownloadManager(storeQD)
  const qd = await mgrQD.add({
    url: `${base}/medium.bin`,
    savePath: join(outDir, 'qd.bin'),
    silent: true
  })
  deadline = Date.now() + 20000
  while (Date.now() < deadline && mgrQD.get(qd.id).state !== 'downloading') await sleep(100)
  ok('indirme başladı', mgrQD.get(qd.id).state === 'downloading', mgrQD.get(qd.id).state)
  if (mgrQD.get(qd.id).state === 'downloading') {
    mgrQD.queue(qd.id)
    const qdi = mgrQD.get(qd.id)
    ok('downloading → queued', qdi.state === 'queued', qdi.state)
    ok('hız sıfırlandı', qdi.progress.speed === 0, `${qdi.progress.speed}`)
  }
  mgrQD.remove(qd.id, true)
  mgrQC.remove(qc.id, true)
  mgrQ.remove(qa.id, false)

  /* ---------------- Yüzen panel: kalite listesi (saf eşleme) ---------------- */
  section('Yüzen panel — video kaliteleri ve ses dosyaları')
  const ff = await import(mod(join(root, 'tests', '.build', 'floatFormats.mjs')))

  ok('HLS adresi tanınır', ff.isStreamAddress('https://cdn.example.com/live/index.m3u8?x=1'))
  ok('mp4 yayın sayılmaz', !ff.isStreamAddress('https://cdn.example.com/v.mp4'))
  ok(
    'çözünürlük ayrıştırma',
    ff.heightOf('1920x1080') === 1080 && ff.heightOf('1080p') === 1080 && ff.heightOf(null) === null
  )
  ok('etiketten kalite', ff.qualityLabel('HD 720p', 'https://x/y.mp4') === '720p')
  ok('adresten kalite', ff.qualityLabel('', 'https://cdn/x_1080.mp4') === '1080p')

  /* --- Liste sayfası / tek video ayrımı ve yt-dlp hata sınıflandırması --- */
  ok(
    'ana sayfa ve akış listeleme sayfası sayılır',
    ff.isGenericPage('https://www.instagram.com/') &&
      ff.isGenericPage('https://www.instagram.com/explore/') &&
      ff.isGenericPage('https://www.instagram.com/reels/') &&
      ff.isGenericPage('https://www.instagram.com/reels/audio/123456/') &&
      ff.isGenericPage('https://www.instagram.com/kullanici/') &&
      ff.isGenericPage('https://www.reddit.com/r/aww/') &&
      ff.isGenericPage('https://www.youtube.com/') &&
      ff.isGenericPage('https://x.com/home') &&
      ff.isGenericPage('')
  )
  ok(
    'tek gönderi/video sayfası çözülebilir sayılır',
    !ff.isGenericPage('https://www.instagram.com/p/CxYz123/') &&
      !ff.isGenericPage('https://www.instagram.com/reel/CxYz123/') &&
      !ff.isGenericPage('https://www.instagram.com/reels/CxYz123/') &&
      !ff.isGenericPage('https://www.instagram.com/reels/CxYz123/?igsh=abc') &&
      !ff.isGenericPage('https://www.reddit.com/r/test/comments/abc123/baslik/') &&
      !ff.isGenericPage('https://www.youtube.com/watch?v=abc123') &&
      !ff.isGenericPage('https://x.com/user/status/123456') &&
      !ff.isGenericPage('https://www.tiktok.com/@user/video/123')
  )
  ok(
    'yt-dlp "Unsupported URL" hatası tanınır',
    ff.classifyProbeError('ERROR: Unsupported URL: https://www.instagram.com/') === 'unsupported'
  )
  ok(
    'oturum/çerez hatası tanınır',
    ff.classifyProbeError(
      'ERROR: [Instagram] Requested content is not available, rate-limit reached or login required'
    ) === 'login' && ff.classifyProbeError('Sign in to confirm you are not a bot') === 'login'
  )
  ok(
    'erişime kapalı içerik tanınır',
    ff.classifyProbeError('ERROR: Video unavailable') === 'unavailable' &&
      ff.classifyProbeError('HTTP Error 404: Not Found') === 'unavailable'
  )
  ok('bilinmeyen hata ham metne düşmez', ff.classifyProbeError('ERROR: something odd') === null)

  const probeRows = ff.formatsFromProbe([
    { formatId: '137', ext: 'mp4', resolution: '1920x1080', fps: 30, vcodec: 'avc1', acodec: null, tbr: 4500, sizeBytes: 300000000, note: '', isAudioOnly: false },
    { formatId: '137dup', ext: 'webm', resolution: '1920x1080', fps: 60, vcodec: 'vp9', acodec: null, tbr: 5200, sizeBytes: null, note: '', isAudioOnly: false },
    { formatId: '136', ext: 'mp4', resolution: '1280x720', fps: 30, vcodec: 'avc1', acodec: null, tbr: 2500, sizeBytes: null, note: '', isAudioOnly: false },
    { formatId: '135', ext: 'mp4', resolution: '854x480', fps: 30, vcodec: 'avc1', acodec: null, tbr: 1200, sizeBytes: null, note: '', isAudioOnly: false },
    { formatId: '18', ext: 'mp4', resolution: '640x360', fps: 30, vcodec: 'avc1', acodec: 'mp4a', tbr: 700, sizeBytes: null, note: '', isAudioOnly: false },
    { formatId: '140', ext: 'm4a', resolution: null, fps: null, vcodec: null, acodec: 'mp4a', tbr: 129, sizeBytes: 4000000, note: '', isAudioOnly: true },
    { formatId: '251', ext: 'webm', resolution: null, fps: null, vcodec: null, acodec: 'opus', tbr: 160, sizeBytes: null, note: '', isAudioOnly: true }
  ])
  const vids = probeRows.filter((r) => r.kind === 'video')
  const auds = probeRows.filter((r) => r.kind === 'audio')
  ok('video kaliteleri tekilleşti', vids.length === 4, JSON.stringify(vids.map((v) => v.label)))
  ok(
    'en yüksek kalite başta ve "en iyi"',
    vids[0].label === '1080p' && vids[0].best === true,
    JSON.stringify(vids[0])
  )
  ok('aynı yükseklikten yüksek bit hızı seçildi', vids[0].formatId === '137dup', vids[0].formatId)
  ok(
    'kalite ayrıntısı (kapsayıcı · çözünürlük · fps)',
    /WEBM/.test(vids[0].detail || '') && /1920×1080/.test(vids[0].detail || '') && /60 fps/.test(vids[0].detail || ''),
    vids[0].detail
  )
  ok('ses dosyaları listelendi', auds.length === 2, JSON.stringify(auds.map((a) => a.label)))
  ok(
    'ses etiketi + bit hızı',
    auds.some((a) => a.label === 'M4A') && /kbps/.test(auds.map((a) => a.detail).join(' ')),
    JSON.stringify(auds)
  )

  // YouTube'un HLS (m3u8) kopyaları aynı çözünürlükte DASH akışından daha
  // yüksek bit hızlı görünür; ama ayrı sesle birleştirilemedikleri için
  // varsayılan seçim DASH olmalı.
  const hlsRows = ff.formatsFromProbe([
    { formatId: '135', ext: 'mp4', resolution: '854x480', fps: 30, vcodec: 'avc1', acodec: null, tbr: 364, sizeBytes: 40922653, note: '', isAudioOnly: false, protocol: 'https' },
    { formatId: '231', ext: 'mp4', resolution: '854x480', fps: 30, vcodec: 'avc1', acodec: null, tbr: 1011, sizeBytes: null, note: '', isAudioOnly: false, protocol: 'm3u8_native', hls: true },
    { formatId: '251', ext: 'webm', resolution: null, fps: null, vcodec: null, acodec: 'opus', tbr: 137, sizeBytes: 15415589, note: '', isAudioOnly: true, protocol: 'https' },
    { formatId: '251h', ext: 'webm', resolution: null, fps: null, vcodec: null, acodec: 'opus', tbr: 200, sizeBytes: null, note: '', isAudioOnly: true, protocol: 'm3u8_native', hls: true }
  ])
  const hlsVid = hlsRows.find((r) => r.kind === 'video')
  const hlsAud = hlsRows.find((r) => r.kind === 'audio')
  ok('HLS video kopyası yerine DASH akışı seçilir', hlsVid?.formatId === '135', hlsVid?.formatId)
  ok('HLS ses kopyası yerine DASH sesi seçilir', hlsAud?.formatId === '251', hlsAud?.formatId)

  const sourceMedia = {
    url: 'https://cdn.example.com/1080.mp4',
    pageUrl: 'https://example.com/watch',
    title: 'Örnek video',
    kind: 'video',
    direct: true,
    sources: [
      { url: 'https://cdn.example.com/1080.mp4', mime: 'video/mp4', label: '1080p' },
      { url: 'https://cdn.example.com/720.mp4', mime: 'video/mp4', label: '720p' },
      { url: 'https://cdn.example.com/480.mp4', mime: 'video/mp4', label: '480p' }
    ]
  }
  const srcRows = ff.formatsFromSources(sourceMedia, { audioExtract: true })
  const srcVids = srcRows.filter((r) => r.kind === 'video')
  const srcAuds = srcRows.filter((r) => r.kind === 'audio')
  ok(
    'oynatıcı <source> listesi kalitelere dönüştü',
    srcVids.length === 3 && srcVids[0].label === '1080p' && srcVids[2].label === '480p',
    JSON.stringify(srcVids.map((v) => v.label))
  )
  ok('kalite satırı doğrudan adresi taşır', srcVids[0].url === 'https://cdn.example.com/1080.mp4')
  ok('en iyi kalite işaretli', srcVids[0].best === true)
  ok(
    'sadece ses (MP3) seçeneği eklendi',
    srcAuds.length === 1 && srcAuds[0].labelKey === 'audioMp3',
    JSON.stringify(srcAuds)
  )

  const singleRow = ff.formatsFromSources(
    { url: 'https://cdn.example.com/movie.webm', pageUrl: '', title: 't', kind: 'video', direct: true },
    { audioExtract: false }
  )
  ok(
    'tek dosyada özgün kalite satırı',
    singleRow.length === 1 && singleRow[0].labelKey === 'origVideo' && singleRow[0].best === true,
    JSON.stringify(singleRow)
  )
  const audioRowsOnly = ff.formatsFromSources(
    { url: 'https://cdn.example.com/song.m4a', pageUrl: '', title: 't', kind: 'audio', direct: true },
    { audioExtract: true }
  )
  ok(
    'ses medyasında özgün ses satırı',
    audioRowsOnly.length === 1 &&
      audioRowsOnly[0].kind === 'audio' &&
      audioRowsOnly[0].formatId === 'direct',
    JSON.stringify(audioRowsOnly)
  )

  // Reddit gibi: oynatıcı tek bir doğrudan mp4 <source> sunar, sayfa ise bir
  // ekstraktördür. Tek kaynak tek satır verdiği için önce yt-dlp denenmeli;
  // tam kalite + ses listesi oradan gelir.
  const extractorMedia = {    url: 'https://v.redd.it/abc123/DASH_720.mp4',
    pageUrl: 'https://www.reddit.com/r/test/comments/abc123/baslik/',
    title: 'Örnek',
    kind: 'video' as const,
    direct: true,
    needsExtractor: true,
    sources: [{ url: 'https://v.redd.it/abc123/DASH_720.mp4', mime: 'video/mp4' }]
  }
  ok(
    'ekstraktör sayfasında kaynak olsa da önce yt-dlp denenir',
    ff.probeFirstTarget(extractorMedia) === extractorMedia.pageUrl,
    ff.probeFirstTarget(extractorMedia)
  )
  ok(
    'tek doğrudan kaynak tek satır verir (tam liste yt-dlp’den)',
    ff.formatsFromSources(extractorMedia, { audioExtract: true }).filter(
      (r) => r.kind === 'video'
    ).length === 1
  )
  ok(
    'ekstraktör olmayan sitede kaynak listesi yeterli',
    ff.probeFirstTarget({
      url: 'https://cdn.example.com/1080.mp4',
      pageUrl: 'https://example.com/watch',
      needsExtractor: false
    }) === null
  )
  ok(
    'akış/profil sayfasında (gönderi adresi yok) yt-dlp denenmez',
    ff.probeFirstTarget({
      url: 'https://cdn.example.com/1080.mp4',
      pageUrl: 'https://www.reddit.com/r/aww/',
      needsExtractor: true
    }) === null
  )

  // Oynatıcı kaliteleri gizli bir HLS manifestinde tutuyorsa (Reddit) panel
  // manifesti yt-dlp'ye çözdürür: tek <source> yerine tüm kaliteler çıkar.
  const hasYtdlp = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' }).status === 0
  if (!hasYtdlp) {
    console.log('  - yt-dlp bulunamadı: manifest sondası atlandı')
  } else {
    const { YtdlpRunner } = await import(mod(join(root, 'tests', '.build', 'ytdlp.mjs')))
    const runner = new YtdlpRunner(
      {
        findYtdlp: () => 'yt-dlp',
        findFfmpeg: () => 'ffmpeg',
        missingYtdlpError: () => new Error('yt-dlp yok')
      },
      join(outDir, 'ytdlp-tmp')
    )
    const manifestProbe = await runner.probe({
      url: `${base}/master.m3u8`,
      useCookies: false,
      impersonate: false
    })
    const manifestRows = ff.formatsFromProbe(manifestProbe.formats)
    const manifestVids = manifestRows.filter((r) => r.kind === 'video')
    ok(
      'HLS manifestinden tüm video kaliteleri çıkar',
      manifestProbe.ok &&
        manifestVids.length >= 2 &&
        manifestVids[0].label === '720p' &&
        manifestVids[1].label === '360p',
      `satır=${JSON.stringify(manifestVids.map((v) => v.label))} ok=${manifestProbe.ok} hata=${manifestProbe.error || ''}`
    )
    ok(
      'manifest satırları manifest adresini taşıyabilir',
      manifestVids.every((r) => typeof r.formatId === 'string' && r.formatId.length > 0)
    )
  }

  /* ---------------- Yüzen panel: uygulama tarafı ---------------- */
  section('Yüzen panel — uygulama köprüsü (FloatService)')
  const fsvcMod = await import(mod(join(root, 'tests', '.build', 'floatService.mjs')))
  const fstore = new FakeStore(makeSettings())
  let probeCount = 0
  const svcCalls: any[] = []
  const svc = new fsvcMod.FloatService({
    store: fstore,
    probeFormats: async () => {
      probeCount++
      return {
        ok: true,
        formats: [
          { formatId: 'h1080', kind: 'video', label: '1080p', best: true },
          { formatId: 'a1', kind: 'audio', label: 'M4A' }
        ]
      }
    },
    download: async (m: any, k: string, f: any) => {
      svcCalls.push({ m, k, f })
      return { ok: true, message: 'kuyruğa eklendi' }
    },
    openFormats: (m: any) => svcCalls.push({ open: m.url }),
    showMainWindow: () => svcCalls.push({ show: true })
  })
  const svcMedia = {
    url: 'https://cdn.example.com/v.mp4',
    pageUrl: 'https://example.com/watch',
    title: 'V',
    kind: 'video' as const
  }
  const firstList = await svc.formats(svcMedia, 'k1')
  ok(
    'FloatService kalite listesi üretir',
    firstList.ok && firstList.formats.length === 2 && firstList.language === 'tr',
    JSON.stringify(firstList)
  )
  await svc.formats(svcMedia, 'k1')
  ok('aynı medya için sonda tekrarlanmaz', probeCount === 1, String(probeCount))
  const chosen = await svc.download(svcMedia, 'video', 'h1080', 'k1')
  ok('seçilen satır indirilir', chosen.ok && svcCalls[0]?.f?.formatId === 'h1080')
  const chosenAudio = await svc.download(svcMedia, 'audio', undefined, 'k1')
  ok(
    'format kimliği yoksa en iyi ses satırı seçilir',
    chosenAudio.ok && svcCalls[1]?.f?.formatId === 'a1'
  )
  const chosenBad = await svc.download(svcMedia, 'video', 'yok', 'k1')
  ok('bilinmeyen satır indirilmez', chosenBad.ok === false)
  fstore.getSettings().extension.floatingPanel = false
  const offList = await svc.formats(svcMedia, 'k1')
  ok('panel ayarı kapalıyken liste verilmez', offList.ok === false && offList.formats.length === 0)
  const offDl = await svc.download(svcMedia, 'video', undefined, 'k1')
  ok('panel ayarı kapalıyken indirme yapılmaz', offDl.ok === false)

  /* ---------------- Yüzen panel: boyut sorgusu ---------------- */
  section('Yüzen panel — kalite satırlarının boyutları')
  const fsizes = await import(mod(join(root, 'tests', '.build', 'floatSizes.mjs')))
  const sized = await fsizes.fillFormatSizes([
    { formatId: 'src:0', kind: 'video', label: '1080p', url: `${base}/video.mp4` },
    { formatId: 'src:1', kind: 'video', label: '720p', url: `${base}/medium.bin` },
    { formatId: 'src:2', kind: 'video', label: 'HLS', url: `${base}/live/index.m3u8` },
    {
      formatId: 'src:3',
      kind: 'audio',
      label: 'M4A',
      url: `${base}/small.txt`,
      sizeBytes: 12345
    },
    { formatId: 'audio:mp3', kind: 'audio', label: 'MP3' }
  ])
  ok(
    'boyutlar Content-Length ile doldu',
    sized[0].sizeBytes === FILES['/video.mp4'].length &&
      sized[1].sizeBytes === FILES['/medium.bin'].length,
    `${sized[0].sizeBytes} / ${sized[1].sizeBytes}`
  )
  ok('HLS satırı sorgulanmaz', sized[2].sizeBytes === undefined)
  ok('bilinen boyut korunur', sized[3].sizeBytes === 12345, String(sized[3].sizeBytes))
  ok('adressiz satır (MP3) boyutsuz kalır', sized[4].sizeBytes === undefined)

  const noWait = await fsizes.fillFormatSizes(
    [{ formatId: 'src:0', kind: 'video', label: '1080p', url: `${base}/video.mp4` }],
    { timeoutMs: 1, budgetMs: 0 }
  )
  ok('bütçe dolunca beklemeden döner', noWait[0].sizeBytes === undefined)

  /* ---------------- Medya: birleştirme sonrası çıktı yolu ---------------- */
  section('Medya — birleştirme sonrası çıktı yolu')
  const fragOut = join(root, 'tests', '.build', 'out.f251.webm')
  const mergedOut = join(root, 'tests', '.build', 'out.mkv')
  writeFileSync(fragOut, 'parca')
  writeFileSync(mergedOut, 'birlesmis')
  ok(
    'birleşmiş dosya parça adına tercih edilir',
    pickExistingOutput([fragOut, mergedOut], 'yedek') === mergedOut,
    pickExistingOutput([fragOut, mergedOut], 'yedek')
  )
  unlinkSync(mergedOut)
  ok(
    'silinen son yol atlanır, var olan seçilir',
    pickExistingOutput([fragOut, mergedOut], 'yedek') === fragOut
  )
  unlinkSync(fragOut)
  ok('hiçbiri yoksa son bildirilen yol', pickExistingOutput([mergedOut], 'yedek') === mergedOut)
  ok('boş liste yedeğe düşer', pickExistingOutput([], 'yedek') === 'yedek')

  /* ---------------- Sonuçlar ---------------- */
  server.close()
  console.log('\n' + '─'.repeat(58))
  console.log(`SONUÇ: ${passed} başarılı, ${failed} başarısız`)
  if (failed > 0) {
    console.log('\nBaşarısızlar:')
    for (const f of failures) console.log('  ✗ ' + f)
    process.exit(1)
  }
  console.log('Tüm testler geçti ✓')
  process.exit(0)
}

main().catch((e) => {
  console.error('\nTEST CRASH:', e)
  server.close()
  process.exit(1)
})
