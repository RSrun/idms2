/**
 * Motor testlerini derler ve koşar:
 *   node scripts/test-engine.mjs
 *
 * tests/*.test.ts dosyalarını esbuild ile electron'suz modüllere paketler,
 * ardından node ile çalıştırır.
 */
import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import { mkdirSync, readdirSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const testsDir = join(root, 'tests')
const outDir = join(testsDir, '.build')

const args = process.argv.slice(2)

// Tek bir test dosyası seçilebilir: node scripts/test-engine.mjs engine
const only = args[0]

if (!existsSync(testsDir)) {
  console.error('tests/ klasörü yok')
  process.exit(1)
}

const testFiles = readdirSync(testsDir).filter(
  (f) => f.endsWith('.test.ts') && (!only || f.startsWith(only))
)

if (testFiles.length === 0) {
  console.error('test dosyası bulunamadı', only ? `(filtre: ${only})` : '')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// Ortak modülleri de derle (test dosyaları bunları import eder)
const sharedEntry = {
  probe: join(root, 'src', 'main', 'engine', 'probe.ts'),
  manager: join(root, 'src', 'main', 'engine', 'manager.ts'),
  segment: join(root, 'src', 'main', 'engine', 'segment.ts'),
  extServer: join(root, 'src', 'main', 'extServer.ts'),
  floatFormats: join(root, 'src', 'main', 'floatFormats.ts'),
  floatSizes: join(root, 'src', 'main', 'floatSizes.ts'),
  i18n: join(root, 'src', 'shared', 'i18n.ts'),
  types: join(root, 'src', 'shared', 'types.ts')
}

async function bundleAll() {
  const jobs = []

  for (const [name, entry] of Object.entries(sharedEntry)) {
    jobs.push({
      entryPoints: [entry],
      outfile: join(outDir, `${name}.mjs`),
      format: 'esm',
      platform: 'node',
      bundle: true,
      external: ['electron', 'ws', 'webtorrent'],
      alias: { '@shared': join(root, 'src', 'shared') },
      logLevel: 'silent'
    })
  }

  for (const f of testFiles) {
    const name = f.replace(/\.test\.ts$/, '')
    jobs.push({
      entryPoints: [join(testsDir, f)],
      outfile: join(outDir, `${name}.test.mjs`),
      format: 'esm',
      platform: 'node',
      bundle: true,
      external: ['electron', 'ws', 'webtorrent'],
      alias: { '@shared': join(root, 'src', 'shared') },
      // Testler derlenmiş ortak modülleri relatif import eder
      plugins: [
        {
          name: 'test-shared',
          setup(b) {
            b.onResolve({ filter: /^virtual:(probe|manager|segment|extServer|i18n|types)$/ }, (a) => ({
              path: join(outDir, `${a.path.split(':')[1]}.mjs`),
              external: true
            }))
          }
        }
      ],
      logLevel: 'silent'
    })
  }

  for (const j of jobs) {
    try {
      await build(j)
    } catch (e) {
      console.error('✗ derleme hatası:', j.entryPoints[0])
      console.error(e.message)
      process.exit(1)
    }
  }
}

await bundleAll()
console.log(`✓ ${testFiles.length} test dosyası derlendi → tests/.build/`)

let anyFailed = false
for (const f of testFiles) {
  const name = f.replace(/\.test\.ts$/, '')
  const outFile = join(outDir, `${name}.test.mjs`)
  console.log(`\n▶ ${f}`)
  const res = spawnSync(process.execPath, [outFile], { stdio: 'inherit', timeout: 180000 })
  if (res.status !== 0) anyFailed = true
}

if (anyFailed) {
  console.log('\n✗ bazı testler başarısız')
  process.exit(1)
}
console.log('\n✓ tüm test paketleri geçti')
