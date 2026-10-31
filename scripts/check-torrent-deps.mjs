/**
 * Torrent bağımlılık koruması.
 *
 * webtorrent 2.x, `uint8-util` 2.3.x ile uyumsuz: `arr2hex()` artık byte dizisi
 * bekliyor, webtorrent ise hex string geçiyor → "ERR_INVALID_ARG_TYPE ... arr2hex".
 * Bu yüzden `uint8-util` 2.2.6'ya sabitlendi (package.json → overrides).
 *
 * Bu betik iki şeyi doğrular:
 *   1. node_modules ağacında yalnızca 2.2.x sürümü var (2.3.x hiçbir yerde olmamalı).
 *   2. Paketlenmiş app.asar (varsa) da 2.2.x taşıyor; yani derleme güncel ağaçla yapılmış.
 *
 * Kullanım:
 *   node scripts/check-torrent-deps.mjs            # kaynak ağacı
 *   node scripts/check-torrent-deps.mjs --asar     # + dist/win-unpacked/resources/app.asar
 *   node scripts/check-torrent-deps.mjs --asar <yol>
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const MAX_DEPTH = 6

const args = process.argv.slice(2)
const asarFlag = args.includes('--asar')
const asarPathArg = args.find((a, i) => args[i - 1] === '--asar' && !a.startsWith('--'))

const problems = []
const found = []

function readVersion(pkgDir) {
  const pkgFile = join(pkgDir, 'package.json')
  if (!existsSync(pkgFile)) return null
  try {
    return JSON.parse(readFileSync(pkgFile, 'utf8')).version ?? null
  } catch {
    return null
  }
}

function record(location, version) {
  found.push({ location, version })
  if (!version || !version.startsWith('2.2.')) {
    problems.push(`${location}: uint8-util ${version ?? 'bilinmiyor'} (2.2.x bekleniyor)`)
  }
}

/** node_modules ağacını gezinip her uint8-util kopyasını kaydeder. */
function scanDeps(dir, depth = 0) {
  if (depth > MAX_DEPTH) return
  const nm = join(dir, 'node_modules')
  if (!existsSync(nm)) return

  let entries
  try {
    entries = readdirSync(nm, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.bin' || entry.name === '.cache') continue

    if (entry.name.startsWith('@')) {
      const scopeDir = join(nm, entry.name)
      let scoped
      try {
        scoped = readdirSync(scopeDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const pkg of scoped) {
        if (!pkg.isDirectory()) continue
        const pkgDir = join(scopeDir, pkg.name)
        checkPkg(pkgDir)
        scanDeps(pkgDir, depth + 1)
      }
      continue
    }

    const pkgDir = join(nm, entry.name)
    checkPkg(pkgDir)
    scanDeps(pkgDir, depth + 1)
  }
}

function checkPkg(pkgDir) {
  if (basename(pkgDir) !== 'uint8-util') return
  if (!existsSync(join(pkgDir, 'package.json'))) return
  const rel = pkgDir.slice(root.length + 1).replace(/\\/g, '/')
  record(rel, readVersion(pkgDir))
}

// 1) Kaynak ağacı
scanDeps(root)
if (found.length === 0) {
  problems.push('node_modules içinde uint8-util bulunamadı (npm install çalıştırın)')
}

// 2) Paketlenmiş asar (isteğe bağlı)
if (asarFlag) {
  const asarPath =
    asarPathArg && !asarPathArg.startsWith('--')
      ? asarPathArg
      : join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')

  if (!existsSync(asarPath)) {
    problems.push(`app.asar bulunamadı: ${asarPath} (önce paketleyin)`)
  } else {
    try {
      const { extractFile } = await import('@electron/asar')
      const inner = join('node_modules', 'uint8-util', 'package.json')
      const pkg = JSON.parse(extractFile(asarPath, inner).toString())
      record(`app.asar!${inner}`, pkg.version ?? null)
    } catch (err) {
      problems.push(`app.asar okunamadı (${asarPath}): ${err.message}`)
    }
  }
}

if (problems.length > 0) {
  console.error('\n✖ Torrent bağımlılık kontrolü başarısız:\n')
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nÇözüm: `npm install` (package.json → overrides.uint8-util = 2.2.6) ve derlemeyi yeniden yapın.\n' +
      'Ayrıntı: docs/torrent-uint8-util-sorunu.md\n'
  )
  process.exit(1)
}

const list = found.map((f) => `  - ${f.location}: ${f.version}`).join('\n')
console.log(`✔ uint8-util sürümleri uygun (2.2.x):\n${list}`)
