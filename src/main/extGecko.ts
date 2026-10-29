/**
 * Firefox / Zen Browser (Gecko) eklenti kurulumu.
 *
 * Gecko tabanlı tarayıcılar imzasız eklentileri varsayılan olarak yüklemez;
 * `about:debugging` ile yüklenen geçici eklenti de tarayıcı kapanınca silinir.
 * Bu modül, eklentiyi profil kapsamına kalıcı olarak kurar:
 *
 *   1. Eklenti kaynağı (`extension/gecko`) `idms2@idms2.app.xpi` olarak paketlenir
 *   2. `<profil>/extensions/idms2@idms2.app.xpi` dosyasına yazılır
 *   3. `<profil>/user.js` içine `xpinstall.signatures.required=false` ve
 *      `extensions.autoDisableScopes=0` eklenir (imza denetimi ve sideload kilidi
 *      yalnızca bu profilde kapanır; eklenti her açılışta yüklenir)
 *
 * Kaldırma işlemi XPI'yi siler ve user.js'ye eklediğimiz satırları temizler.
 */

import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, normalize, resolve } from 'path'
import type { GeckoProfile } from '@shared/types'
import { writeZip } from './zip'

export const GECKO_ADDON_ID = 'idms2@idms2.app'
const GECKO_XPI = `${GECKO_ADDON_ID}.xpi`
const SIGN_PREF = 'xpinstall.signatures.required'
const USER_JS_MARKER = '// IDMS: yerel eklenti (imza denetimi ve sideload kilidi kapali)'

const IS_WIN = process.platform === 'win32'

interface BrowserDef {
  id: 'zen' | 'firefox'
  name: string
  exeNames: string[]
  appDirNames: string[]
  profileRoot: () => string
}

function envPath(name: string): string | undefined {
  return process.env[name] || undefined
}

const BROWSERS: BrowserDef[] = [
  {
    id: 'zen',
    name: 'Zen Browser',
    exeNames: ['zen.exe'],
    appDirNames: ['Zen Browser'],
    profileRoot: () => join(envPath('APPDATA') || join(homedir(), 'AppData', 'Roaming'), 'zen')
  },
  {
    id: 'firefox',
    name: 'Firefox',
    exeNames: ['firefox.exe'],
    appDirNames: ['Mozilla Firefox'],
    profileRoot: () =>
      join(envPath('APPDATA') || join(homedir(), 'AppData', 'Roaming'), 'Mozilla', 'Firefox')
  }
]

function installCandidates(def: BrowserDef): string[] {
  if (!IS_WIN) return []
  const roots = [
    envPath('ProgramFiles'),
    envPath('ProgramFiles(x86)'),
    envPath('ProgramW6432'),
    envPath('LOCALAPPDATA') ? join(envPath('LOCALAPPDATA')!, 'Programs') : undefined,
    envPath('LOCALAPPDATA')
  ].filter(Boolean) as string[]

  const out: string[] = []
  for (const root of roots) {
    for (const dir of def.appDirNames) {
      for (const exe of def.exeNames) out.push(join(root, dir, exe))
    }
  }
  return [...new Set(out)]
}

function findExe(def: BrowserDef): string {
  return installCandidates(def).find((p) => existsSync(p)) || ''
}

interface IniSection {
  name: string
  values: Record<string, string>
}

function parseIni(file: string): IniSection[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const sections: IniSection[] = []
  let current: IniSection | null = null
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      current = { name: header[1], values: {} }
      sections.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0 && current) current.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => normalize(resolve(p)).replace(/[\\/]+$/, '')
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/** İki profil yolunun aynı klasörü gösterip göstermediği (Windows'ta harf duyarsız) */
export function pathsEqual(a: string, b: string): boolean {
  return samePath(a, b)
}

interface ProfileEntry {
  name: string
  dir: string
  isDefault: boolean
}

/** profiles.ini → profil listesi (yollar ini dosyasına göre çözülür) */
function readProfiles(def: BrowserDef): ProfileEntry[] {
  const ini = join(def.profileRoot(), 'profiles.ini')
  const sections = parseIni(ini)
  if (sections.length === 0) return []

  const installDefaults = sections
    .filter((s) => s.name.startsWith('Install'))
    .map((s) => s.values.Default)
    .filter(Boolean)
    .map((d) => (isAbsolute(d) ? d : join(dirname(ini), d)))

  const entries: ProfileEntry[] = []
  for (const section of sections) {
    if (!/^Profile\d+$/.test(section.name)) continue
    const rel = section.values.Path
    if (!rel) continue
    const dir = section.values.IsRelative === '1' ? join(dirname(ini), rel) : rel
    if (!existsSync(dir)) continue
    // `[Install…] Default` gerçek açılış profilidir; yoksa eski `Default=1`
    // işaretine düşülür (ikisi birlikteyken iki profil "varsayılan" görünmesin).
    const isDefault =
      installDefaults.length > 0
        ? installDefaults.some((d) => samePath(d, dir))
        : section.values.Default === '1'
    entries.push({ name: section.values.Name || section.name, dir, isDefault })
  }

  // Varsayılan profil önce gelsin
  entries.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return entries
}

/** Eklentinin imza denetimi kapalı mı? (user.js veya prefs.js) */
function signaturesDisabled(profileDir: string): boolean {
  const re = new RegExp(`user_pref\\("${SIGN_PREF.replace(/\./g, '\\.')}",\\s*false\\)`)
  for (const file of [join(profileDir, 'user.js'), join(profileDir, 'prefs.js')]) {
    try {
      if (re.test(readFileSync(file, 'utf8'))) return true
    } catch {
      /* dosya yok */
    }
  }
  return false
}

function browserRunning(def: BrowserDef): boolean {
  if (!IS_WIN) return false
  try {
    const out = execFileSync(
      'tasklist.exe',
      ['/FI', `IMAGENAME eq ${def.exeNames[0]}`, '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    )
    return out.toLowerCase().includes(def.exeNames[0].toLowerCase())
  } catch {
    return false
  }
}

/**
 * Kurulu Gecko tarayıcılarını ve profillerini listeler.
 * Tarayıcı kurulu değilse profil varsa yine listelenir (taşınabilir kurulum).
 */
export function listGeckoProfiles(): GeckoProfile[] {
  const out: GeckoProfile[] = []
  for (const def of BROWSERS) {
    const entries = readProfiles(def)
    if (entries.length === 0) continue
    const exe = findExe(def)
    const running = browserRunning(def)
    for (const entry of entries) {
      const extensionsDir = join(entry.dir, 'extensions')
      out.push({
        browser: def.id,
        browserName: def.name,
        exe,
        profileDir: entry.dir,
        profileName: entry.name,
        isDefault: entry.isDefault,
        installed: existsSync(join(extensionsDir, GECKO_XPI)),
        unpacked: existsSync(join(extensionsDir, GECKO_ADDON_ID)),
        signaturesDisabled: signaturesDisabled(entry.dir),
        running
      })
    }
  }
  return out
}

const INSTALL_PREFS = [
  `user_pref("${SIGN_PREF}", false);`,
  'user_pref("extensions.autoDisableScopes", 0);'
] as const

const INSTALL_PREF_RES = INSTALL_PREFS.map(
  (line) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
)

/**
 * Profil `user.js` dosyasına kurulum için gereken iki prefi yazar:
 *  - `xpinstall.signatures.required=false` → imzasız XPI yüklenebilsin
 *  - `extensions.autoDisableScopes=0` → profile bırakılan eklenti otomatik
 *    devre dışı bırakılmasın (Firefox "sideload" davranışı)
 */
function ensureInstallPrefs(profileDir: string): void {
  const file = join(profileDir, 'user.js')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const missing = INSTALL_PREFS.filter((line) => !existing.includes(line))
  if (missing.length === 0) return

  let next: string
  if (!existing.includes(USER_JS_MARKER)) {
    const block = `${USER_JS_MARKER}\n${missing.join('\n')}\n`
    next = existing && !existing.endsWith('\n') ? `${existing}\n${block}` : existing + block
  } else {
    // İşaretçiden sonra eksik satırları ekle (bloğu bozmadan)
    const lines = existing.split(/\r?\n/)
    const at = lines.findIndex((l) => l.trim() === USER_JS_MARKER)
    lines.splice(at + 1, 0, ...missing)
    next = lines.join('\n')
  }
  writeFileSync(file, next, 'utf8')
}

/** Kurulum sırasında eklediğimiz pref satırlarını ve işaretçiyi temizler. */
function removeInstallPrefs(profileDir: string): void {
  const file = join(profileDir, 'user.js')
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  if (!text.includes(USER_JS_MARKER)) return

  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === USER_JS_MARKER) {
      // İşaretçiden sonra bizim preflerimiz gelir; onları atla
      while (i + 1 < lines.length && INSTALL_PREF_RES.some((re) => re.test(lines[i + 1].trim()))) {
        i++
      }
      continue
    }
    kept.push(lines[i])
  }
  const rest = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (rest) writeFileSync(file, `${rest}\n`, 'utf8')
  else rmSync(file, { force: true })
}

function readAddonId(extDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'))
    return manifest?.browser_specific_settings?.gecko?.id ?? null
  } catch {
    return null
  }
}

/**
 * Eklentiyi profil kapsamına kurar. Tarayıcı açıksa yeni eklenti ancak
 * yeniden başlatmada yüklenir (çağıran taraf `running` bilgisini kullanır).
 */
export function installGeckoExtension(profileDir: string, extDir: string): void {
  if (!existsSync(join(profileDir, 'prefs.js')) && !existsSync(join(profileDir, 'times.json'))) {
    throw new Error('Profil klasörü geçerli görünmüyor')
  }
  if (readAddonId(extDir) !== GECKO_ADDON_ID) {
    throw new Error('Eklenti kaynağı bulunamadı (gecko hedefi eksik)')
  }

  const extensionsDir = join(profileDir, 'extensions')
  mkdirSync(extensionsDir, { recursive: true })

  // Aynı kimlikle açılmış (about:debugging) paketsiz klasör kalıntısını temizle
  rmSync(join(extensionsDir, GECKO_ADDON_ID), { recursive: true, force: true })

  const xpi = join(extensionsDir, GECKO_XPI)
  const temp = join(extensionsDir, `${GECKO_ADDON_ID}.tmp.zip`)
  try {
    writeZip(extDir, temp)
    rmSync(xpi, { force: true })
    renameSync(temp, xpi)
  } catch (err) {
    rmSync(temp, { force: true })
    throw new Error(
      `Eklenti yazılamadı (tarayıcı açıksa kapatın): ${(err as Error).message}`
    )
  }

  ensureInstallPrefs(profileDir)
}

/** Eklentiyi ve eklediğimiz imza ayarını profilden kaldırır. */
export function uninstallGeckoExtension(profileDir: string): void {
  const extensionsDir = join(profileDir, 'extensions')
  rmSync(join(extensionsDir, GECKO_XPI), { force: true })
  rmSync(join(extensionsDir, GECKO_ADDON_ID), { recursive: true, force: true })
  removeInstallPrefs(profileDir)
}

/** Test/CLI için: verilen profilde eklenti kurulu mu? */
export function isGeckoExtensionInstalled(profileDir: string): boolean {
  return existsSync(join(profileDir, 'extensions', GECKO_XPI))
}
