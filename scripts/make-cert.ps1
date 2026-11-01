#requires -Version 5.1
<#
  IDMS için kendinden imzalı kod imzalama sertifikası üretir.

  Ne yapar:
    1. CurrentUser\My deposunda kod imzalama sertifikası oluşturur (RSA 3072, SHA-256, 5 yıl).
    2. Sertifikayı .pfx (parola korumalı) ve .cer olarak diske yazar.
    3. Parolayı pfx-password.txt dosyasına yazar.
    4. .cer dosyasını CurrentUser\Root ve CurrentUser\TrustedPublisher depolarına ekler,
       böylece bu makinede imza "Valid" görünür.

  Not: Kendinden imzalı sertifika yalnızca sertifikanın yüklendiği makinelerde
  güvenilirdir. Başka bilgisayarlarda "Bilinmeyen yayıncı" görünür; dağıtım için
  CA'dan alınmış bir kod imzalama sertifikası gerekir.

  Kullanım:
    npm run cert:new
    powershell -NoProfile -File scripts/make-cert.ps1 -Subject "CN=Firma Adı, O=Firma, C=TR"
#>
param(
  [string]$Subject = 'CN=IDMS, O=IDMS, OU=Desktop, C=TR',
  [int]$Years = 5,
  [string]$OutDir = "$env:USERPROFILE\idms-signing",
  [string]$PfxPassword
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "▸ Sertifika oluşturuluyor: $Subject"

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears($Years)

if (-not $PfxPassword) {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $PfxPassword = [Convert]::ToBase64String($bytes)
}

$secure = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
$pfxPath = Join-Path $OutDir 'idms-codesign.pfx'
$cerPath = Join-Path $OutDir 'idms-codesign.cer'

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Set-Content -Path (Join-Path $OutDir 'pfx-password.txt') -Value $PfxPassword -NoNewline -Encoding ASCII

# Kök sertifika deposuna eklerken Windows onay penceresi istememesi için certutil
certutil -user -addstore Root $cerPath | Out-Null
try {
  Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
} catch {
  Write-Host "  ! TrustedPublisher deposuna eklenemedi: $($_.Exception.Message)"
}

Write-Host ''
Write-Host "  Parmak izi : $($cert.Thumbprint)"
Write-Host "  Geçerlilik : $($cert.NotBefore.ToString('yyyy-MM-dd')) → $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "  PFX        : $pfxPath"
Write-Host "  Sertifika  : $cerPath"
Write-Host "  Parola     : $(Join-Path $OutDir 'pfx-password.txt')"
Write-Host ''
Write-Host '✓ Hazır. İmzalı derleme için: npm run dist:signed'
Write-Host '  Bu sertifika yalnızca bu makinede güvenilirdir; dağıtım için CA sertifikası gerekir.'
