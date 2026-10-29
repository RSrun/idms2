/**
 * Gecko (Firefox / Zen) eklenti kurulumu testleri.
 *
 * Gerçek tarayıcı profiline dokunmaz: geçici klasörde sahte profil oluşturur,
 * `installGeckoExtension` ile XPI + user.js yazar, sonra kaldırır.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GECKO_ADDON_ID,
  installGeckoExtension,
  pathsEqual,
  uninstallGeckoExtension
} from '../src/main/extGecko'

const extDir = join(process.cwd(), 'extension', 'gecko')
const root = mkdtempSync(join(tmpdir(), 'idms-gecko-'))

function makeProfile(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'extensions'), { recursive: true })
  writeFileSync(join(dir, 'times.json'), '{}')
  writeFileSync(join(dir, 'prefs.js'), '// prefs\n')
  return dir
}

try {
  // 1) Temel kurulum: XPI + imza ayarı
  const profile = makeProfile('profile-a')
  installGeckoExtension(profile, extDir)

  const xpi = join(profile, 'extensions', `${GECKO_ADDON_ID}.xpi`)
  assert.ok(existsSync(xpi), 'XPI yazılmalı')

  const head = readFileSync(xpi).subarray(0, 4)
  assert.deepEqual([...head], [0x50, 0x4b, 0x03, 0x04], 'XPI geçerli bir ZIP olmalı')
  assert.ok(readFileSync(xpi).length > 5000, 'XPI eklenti dosyalarını içermeli')

  const userJs = join(profile, 'user.js')
  const text = readFileSync(userJs, 'utf8')
  assert.match(text, /xpinstall\.signatures\.required", false/, 'imza denetimi kapanmalı')
  assert.match(text, /extensions\.autoDisableScopes", 0/, 'sideload kilidi kapanmalı')
  assert.match(text, /IDMS: yerel eklenti/, 'eklenen blok işaretlenmeli')

  // 2) Yeniden kurulum tekrar satır eklememeli
  installGeckoExtension(profile, extDir)
  const updated = readFileSync(userJs, 'utf8')
  const prefCount = updated.split('xpinstall.signatures.required').length - 1
  const autoCount = updated.split('extensions.autoDisableScopes').length - 1
  assert.equal(prefCount, 1, 'imza prefi bir kez yazılmalı')
  assert.equal(autoCount, 1, 'sideload prefi bir kez yazılmalı')

  // 3) Kaldırma: XPI ve bizim satırlarımız silinmeli
  uninstallGeckoExtension(profile)
  assert.ok(!existsSync(xpi), 'XPI silinmeli')
  assert.ok(!existsSync(userJs), 'yalnızca bizim satırlarımız varsa user.js silinmeli')

  // 4) Kullanıcının kendi user.js içeriği korunmalı
  const profile2 = makeProfile('profile-b')
  const own = 'user_pref("browser.tabs.warnOnClose", false);\n'
  writeFileSync(join(profile2, 'user.js'), own)
  installGeckoExtension(profile2, extDir)
  assert.ok(readFileSync(join(profile2, 'user.js'), 'utf8').includes(own.trim()))
  uninstallGeckoExtension(profile2)
  const rest = readFileSync(join(profile2, 'user.js'), 'utf8')
  assert.equal(rest.trim(), own.trim(), 'kullanıcı satırı kalmalı')
  assert.ok(!rest.includes('xpinstall.signatures.required'), 'bizim pref kaldırılmalı')

  // 5) Var olmayan profil reddedilmeli
  assert.throws(
    () => installGeckoExtension(join(root, 'yok'), extDir),
    /Profil klasörü/,
    'geçersiz profil hata vermeli'
  )

  // 6) Geçersiz eklenti kaynağı reddedilmeli
  const empty = join(root, 'empty-ext')
  mkdirSync(empty, { recursive: true })
  writeFileSync(join(empty, 'manifest.json'), JSON.stringify({ name: 'x' }))
  assert.throws(
    () => installGeckoExtension(makeProfile('profile-c'), empty),
    /Eklenti kaynağı/,
    'gecko kimliği olmayan kaynak reddedilmeli'
  )

  // 7) Yol karşılaştırması (Windows'ta harf duyarsız)
  if (process.platform === 'win32') {
    assert.ok(pathsEqual('C:\\A\\b', 'c:\\a\\B'), 'yollar harf duyarsız eşleşmeli')
  }
  assert.ok(pathsEqual(join(root, 'x'), join(root, 'x')), 'aynı yollar eşleşmeli')

  console.log('✓ extGecko: XPI paketleme, imza ayarı, kaldırma ve doğrulamalar geçti')
} finally {
  rmSync(root, { recursive: true, force: true })
}
