/**
 * TorrentManager çift ekleme testi.
 *
 *   node scripts/test-torrent-dedupe.mjs
 *
 * Aynı torrent ikinci kez eklenince webtorrent "Cannot add duplicate torrent"
 * hatası fırlatır. TorrentManager bunu hataya değil, mevcut kayda yönlendirmeli
 * (`duplicate: true`, aynı id).
 *
 * Test, TorrentManager'ı esbuild ile (electron sahte modülüyle) paketler;
 * gerçek webtorrent kullanılır ama DHT/LSD/UPnP kapalıdır — ağ gerekmez.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'tests', '.build')
const outFile = join(outDir, 'torrent-dedupe.mjs')

const electronStub = `
export const app = { isPackaged: false, setAsDefaultProtocolClient () {} }
export class BrowserWindow {}
`

const testSource = `
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTorrent from 'create-torrent'
import { TorrentManager } from ${JSON.stringify(join(root, 'src', 'main', 'torrent.ts'))}

const work = mkdtempSync(join(tmpdir(), 'idms-dedupe-'))
const saveDir = join(work, 'downloads')
const contentFile = join(work, 'ornek.txt')
writeFileSync(contentFile, 'IDMS torrent dedupe testi\\n')

const torrentFile = join(work, 'ornek.torrent')
await new Promise((resolve, reject) => {
  createTorrent(contentFile, { name: 'ornek.txt', announce: [] }, (err, buf) => {
    if (err) return reject(err)
    writeFileSync(torrentFile, buf)
    resolve()
  })
})

const settings = {
  torrent: { saveDir, dht: false, utp: false, port: 0, seedRatioLimit: 0 }
}
const manager = new TorrentManager({ getSettings: () => settings })

let failed = false
const check = (name, ok) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name)
  if (!ok) failed = true
}

try {
  const first = await manager.add(torrentFile)
  check('ilk ekleme yeni kayıt açar', first.duplicate === false)

  const second = await manager.add(torrentFile)
  check('ikinci ekleme hata vermez', second.duplicate === true)
  check('ikinci ekleme aynı kimliği döndürür', second.id === first.id)
  check('etkin torrent sayısı 1 kalır', manager.running === 1)
  check('torrent adı okunur', manager.name(first.id) === 'ornek.txt')
} catch (err) {
  failed = true
  console.error('  ✗ beklenmeyen hata:', err?.stack || err)
} finally {
  await manager.shutdown()
  rmSync(work, { recursive: true, force: true })
}

if (failed) {
  console.log('\\n✗ torrent çift ekleme testi başarısız')
  process.exit(1)
}
console.log('\\n✓ torrent çift ekleme testi geçti')
`

let failed = false

try {
  await build({
    stdin: { contents: testSource, resolveDir: root, sourcefile: 'torrent-dedupe.ts', loader: 'ts' },
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['webtorrent', 'create-torrent'],
    plugins: [
      {
        name: 'electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
          b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
            contents: electronStub,
            loader: 'js'
          }))
        }
      }
    ],
    logLevel: 'silent'
  })
} catch (err) {
  console.error('✗ derleme hatası:', err.message)
  process.exit(1)
}

const res = spawnSync(process.execPath, [outFile], { stdio: 'inherit', timeout: 120000 })
if (res.status !== 0) failed = true

process.exit(failed ? 1 : 0)
