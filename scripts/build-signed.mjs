#!/usr/bin/env node
/**
 * Windows derlemesi (imza varsa imzalı).
 *
 *   npm run dist          → sertifika varsa imzalar, yoksa imzasız derler
 *   npm run dist:signed   → sertifika yoksa hata verir
 *   npm run dist:unsigned → her zaman imzasız derler
 *
 * Sertifika ve parolası depo dışında tutulur:
 *   %USERPROFILE%\idms-signing\idms-codesign.pfx
 *   %USERPROFILE%\idms-signing\pfx-password.txt
 *
 * Başka bir sertifika (ör. satın alınmış CA sertifikası) kullanmak için
 * CSC_LINK ve CSC_KEY_PASSWORD ortam değişkenlerini vermek yeterlidir;
 * bu durumda yukarıdaki dosyalar okunmaz.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const requireCert = process.argv.includes('--require-cert')
const signDir = process.env.IDMS_SIGN_DIR || join(homedir(), 'idms-signing')
const pfxPath = resolve(process.env.CSC_LINK || join(signDir, 'idms-codesign.pfx'))
const passwordFile = join(signDir, 'pfx-password.txt')

function run(command) {
  const result = spawnSync(command, { stdio: 'inherit', shell: true, env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const hasCert = existsSync(pfxPath)

if (!hasCert) {
  if (requireCert) {
    fail(
      `İmza sertifikası bulunamadı: ${pfxPath}\n` +
        '  Yeni sertifika için: npm run cert:new\n' +
        '  CA sertifikası için: CSC_LINK ve CSC_KEY_PASSWORD ayarlayın.'
    )
  }
  console.log('▸ İmza sertifikası yok, imzasız derleme yapılıyor.')
  console.log('  İmzalı derleme için: npm run cert:new && npm run dist\n')
  run('npm run build:win')
  run('npm run verify:build')
  process.exit(0)
}

let password = process.env.CSC_KEY_PASSWORD
if (!password) {
  if (!existsSync(passwordFile)) {
    fail(
      `Sertifika parolası yok: ${passwordFile}\n` +
        '  CSC_KEY_PASSWORD ortam değişkenini ayarlayın veya sertifikayı yeniden üretin (npm run cert:new).'
    )
  }
  password = readFileSync(passwordFile, 'utf8').trim()
  if (!password) fail(`Parola dosyası boş: ${passwordFile}`)
}

if (!/\.(pfx|p12)$/i.test(pfxPath)) {
  fail(`Desteklenmeyen sertifika biçimi: ${pfxPath} (.pfx veya .p12 olmalı)`)
}

process.env.CSC_LINK = pfxPath
process.env.CSC_KEY_PASSWORD = password

console.log(`▸ Sertifika: ${pfxPath}`)
console.log('▸ Derleme ve imzalama başlıyor...\n')

run('npm run build:win')
run('npm run verify:build')

/* ------------------------------------------------------------------ */
/* İmza doğrulama                                                      */
/* ------------------------------------------------------------------ */

const targets = [join('dist', 'win-unpacked', 'IDMS.exe')]
try {
  for (const name of readdirSync('dist')) {
    if (/^IDMS Setup .*\.exe$/i.test(name)) targets.push(join('dist', name))
  }
} catch {
  /* dist yoksa doğrulama atlanır */
}

const script = `
$paths = @(${targets.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})
foreach ($p in $paths) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Output "YOK|$p"; continue }
  $s = Get-AuthenticodeSignature -LiteralPath $p
  $signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }
  $stamp = if ($s.TimeStamperCertificate) { $s.TimeStamperCertificate.NotAfter.ToString('yyyy-MM-dd') } else { '' }
  Write-Output ("RESULT|{0}|{1}|{2}|{3}" -f $p, $s.Status, $signer, $stamp)
}
`

console.log('\n▸ İmza doğrulaması:')
const verify = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8'
})

let valid = true
for (const line of (verify.stdout || '').split(/\r?\n/)) {
  if (line.startsWith('RESULT|')) {
    const [, path, status, signer, stamp] = line.split('|')
    const ok = status === 'Valid'
    if (!ok) valid = false
    console.log(`  ${ok ? '✓' : '✗'} ${path}`)
    console.log(`      durum: ${status} | imzalayan: ${signer || '-'} | zaman damgası: ${stamp || '-'}`)
  } else if (line.startsWith('YOK|')) {
    console.log(`  - ${line.slice(4)} bulunamadı, atlandı`)
  }
}
if (verify.status !== 0) {
  console.error(verify.error?.message || verify.stderr || 'Doğrulama çalıştırılamadı')
}

if (!valid) {
  console.warn(
    '\n! İmza doğrulanamadı. Sertifika bu makinenin "Güvenilen Kök Sertifika Yetkilileri"\n' +
      '  deposunda değilse durum "UnknownError" görünür; imza yine de dosyaya eklenmiştir.\n' +
      '  Yerel güven için: npm run cert:new (veya sertifikayı elle içe aktarın).'
  )
}

console.log('\n✓ İmzalı derleme tamamlandı.')
