/**
 * IDMS tarayıcı eklentisi derlemesi
 *
 *   extension/shared/*        → tek kaynak (betikler + popup + ikonlar)
 *   extension/manifests/*.json → hedefe özel manifest
 *   extension/chromium/       → Chrome / Edge / Brave (MV3 service worker)
 *   extension/firefox/        → Firefox (MV3 event page)
 *   extension/gecko/          → Firefox paketleme (about:debugging) — aynı dosyalar
 *
 * Hedef klasörler her çalıştırmada silinip sıfırdan üretilir; böylece eski
 * sürümden kalan dosya kalmaz.
 *
 *   node scripts/build-extension.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const extRoot = join(root, 'extension')
const shared = join(extRoot, 'shared')
const manifests = join(extRoot, 'manifests')

const TARGETS = [
  { dir: 'chromium', manifest: 'chromium.json' },
  { dir: 'firefox', manifest: 'firefox.json' },
  { dir: 'gecko', manifest: 'firefox.json' }
]

const REQUIRED_SHARED = [
  'background.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
]

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function checkSyntax(dir, file) {
  try {
    // Manifest'teki betikler klasik betiklerdir (modül değil).
    new Function(readFileSync(join(dir, file), 'utf8'))
  } catch (err) {
    fail(`${relative(root, join(dir, file))} sözdizimi hatası: ${err.message}`)
  }
}

function validate(dir, manifest, targetDir) {
  if (manifest.manifest_version !== 3) fail(`${targetDir}: manifest_version 3 olmalı`)
  if (!manifest.name) fail(`${targetDir}: name eksik`)
  if (!manifest.version) fail(`${targetDir}: version eksik`)

  const refs = []
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker)
  if (manifest.background?.scripts) refs.push(...manifest.background.scripts)
  if (manifest.action?.default_popup) refs.push(manifest.action.default_popup)
  for (const cs of manifest.content_scripts ?? []) {
    if (!cs.matches?.length) fail(`${targetDir}: content_scripts.matches eksik`)
    refs.push(...(cs.js ?? []), ...(cs.css ?? []))
  }
  refs.push(...Object.values(manifest.icons ?? {}))
  refs.push(...Object.values(manifest.action?.default_icon ?? {}))

  for (const ref of new Set(refs)) {
    if (!existsSync(join(dir, ref))) fail(`${targetDir}: manifest referansı eksik → ${ref}`)
  }

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    checkSyntax(dir, file)
  }

  // Popup HTML'indeki yerel script/stil bağlantıları
  const popup = manifest.action?.default_popup
  if (popup) {
    const html = readFileSync(join(dir, popup), 'utf8')
    for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const ref = m[1]
      if (/^(https?:|data:|#)/.test(ref)) continue
      if (!existsSync(join(dir, ref))) fail(`${targetDir}/${popup}: eksik dosya → ${ref}`)
    }
  }

  if (!manifest.permissions?.includes('storage')) fail(`${targetDir}: storage izni eksik`)
  if (!manifest.permissions?.includes('downloads')) fail(`${targetDir}: downloads izni eksik`)
  if (!manifest.host_permissions?.length) fail(`${targetDir}: host_permissions eksik`)
}

// ---------------------------------------------------------------------------
// Paylaşılan kaynak kontrolü
// ---------------------------------------------------------------------------
if (!existsSync(shared)) fail('extension/shared bulunamadı')
if (!existsSync(manifests)) fail('extension/manifests bulunamadı')

for (const file of REQUIRED_SHARED) {
  if (!existsSync(join(shared, file))) fail(`extension/shared/${file} eksik`)
}

// ---------------------------------------------------------------------------
// Hedefleri sıfırdan üret
// ---------------------------------------------------------------------------
for (const target of TARGETS) {
  const dir = join(extRoot, target.dir)
  const manifestPath = join(manifests, target.manifest)
  if (!existsSync(manifestPath)) fail(`manifest bulunamadı: ${target.manifest}`)

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(shared, dir, { recursive: true })

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    fail(`${target.manifest} geçersiz JSON: ${err.message}`)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  validate(dir, manifest, target.dir)

  if (target.dir === 'chromium' && manifest.background?.service_worker !== 'background.js') {
    fail('chromium: background.service_worker = background.js olmalı')
  }
  if (target.dir !== 'chromium') {
    if (!manifest.background?.scripts?.includes('background.js')) {
      fail(`${target.dir}: background.scripts içinde background.js olmalı`)
    }
    if (!manifest.browser_specific_settings?.gecko?.id) {
      fail(`${target.dir}: browser_specific_settings.gecko.id eksik`)
    }
  }

  console.log(
    `✓ ${target.dir.padEnd(8)} ${manifest.name} v${manifest.version}` +
      `  (${readdirSync(dir).length} kök öğe, manifest: ${target.manifest})`
  )
}

console.log('eklenti derlemesi tamam ✓')
