# Paketleme sorunu: `Cannot find module ...\isexe\index.js`

**Durum:** Çözüldü · **Etki:** Yalnızca paketlenmiş uygulama (`IDMS.exe`), `npm run dev` etkilenmiyordu
**Bileşenler:** electron-builder 26.18.0, @electron/asar 3.4.1, Electron 37.10.3, Node 24.19.0

---

## 1. Belirti

Paketlenmiş `IDMS.exe` açılmıyor, ana süreçte bir JavaScript hatası penceresi çıkıyor:

```
A JavaScript error occurred in the main process
Uncaught Exception:
Error: Cannot find module 'C:\idms-build\win-unpacked\resources\app.asar\node_modules\isexe\index.js'.
Please verify that the package.json has a valid "main" entry
    at tryPackage (node:internal/modules/cjs/loader:509:19)
    ...
```

Pencere kapanmıyor (uygulama süreci yaşıyor) ama uygulama penceresi hiç açılmıyor.
`npm run dev` ve `npm run start` çalışıyordu; hata yalnızca electron-builder çıktısındaydı.

---

## 2. Kök neden

### 2.1 Modül neden yükleniyor?

Uygulama açılırken webtorrent (torrent desteği) zinciri yükleniyor ve bu zincirin sonunda
`isexe` var:

```
webtorrent
 └─ @silentbot1/nat-api        (UPnP / NAT-PMP)
     └─ default-gateway        (ağ geçidini bulur)
         └─ execa@7
             └─ cross-spawn@7
                 └─ which@2.0.2
                     └─ isexe@2.0.0
```

`default-gateway`, `execa`'yı modül üstünde (`import`) yüklüyor. Dolayısıyla `isexe`
**uygulama açılışında**, ilk pencere oluşmadan önce çözümlenmeye çalışılıyor. Dosya
pakette yoksa süreç `uncaughtException` ile duruyor.

### 2.2 npm ağacındaki sürüm çakışması

`node_modules` içinde aynı paketin iki sürümü vardı:

| Konum | Sürüm | Rol | `package.json` |
| --- | --- | --- | --- |
| `node_modules/isexe` | 3.1.5 | **dev** — `which@5` (electron-builder'ın kendi aracı) | `main: ./dist/commonjs/index.min.js`, `files: ["dist"]`, `type: module` |
| `node_modules/cross-spawn/node_modules/isexe` | 2.0.0 | **üretim** — `which@2` üzerinden uygulama | `main: index.js` (kök dizinde) |

electron-builder yalnızca üretim bağımlılıklarını paketler, fakat ağacı hedef
`node_modules/` yapısına düzleştirir. Bu iki kayıt aynı hedefe (`node_modules/isexe`)
düştü ve sonuç tutarsız oldu: **v2'nin `package.json`'u** pakete girdi (yani `main`
olarak `index.js` bekleniyor) ama **dosyalar gelmedi** — `isexe` klasöründe yalnızca
`LICENSE` ve `package.json` vardı.

`isexe@3`'ün `files: ["dist"]` alanı etkili olmuş gibi görünüyor: v2 dizini için
"yayınlanacak dosyalar" listesi boş kaldığından geriye sadece npm'in her zaman
eklediği `package.json` ve `LICENSE` kalmış.

### 2.3 Kanıtlar

Bozuk paket (`C:\idms-build\win-unpacked\resources\app.asar`):

```
node_modules/isexe
node_modules/isexe/LICENSE
node_modules/isexe/package.json     ← v2.0.0, "main": "index.js"
```

Eksik dosyalar: `index.js`, `mode.js`, `windows.js`.

Karşılaştırma (asar girdi sayısı):

| Paket | Girdi | `isexe` içeriği |
| --- | --- | --- |
| Bozuk derleme | 1723 | yalnızca `LICENSE`, `package.json` |
| Sağlıklı derleme | 1911 | `LICENSE`, `index.js`, `mode.js`, `package.json`, `windows.js` |

Aynı derlemede `isexe` dışında 188 dosya daha eksikti (`base64-js`, `bl`, `buffer`,
`node-abi`, `prebuild-install` zincirine ait ~20 paket). Bu, o derlemede kullanılan
`node_modules` durumunun tutarlı olmadığını gösteriyor (dosya zaman damgaları
`00:24`, derleme ise `00:11` idi — yarım kalmış bir kurulumun izleri).

---

## 3. Düzeltme

Tek ve kalıcı değişiklik: `isexe@2`'yi **doğrudan üretim bağımlılığı** yapmak.
Böylece npm onu üst düzeye sabitler, farklı sürümler aynı hedefe düşmez.

`package.json`:

```json
"dependencies": {
  "isexe": "^2.0.0",
  "react": "^19.1.0",
  "react-dom": "^19.1.0",
  "webtorrent": "^2.5.1",
  "ws": "^8.18.3"
}
```

`package-lock.json` üzerindeki etkisi:

- `node_modules/isexe` → **2.0.0** (artık `dev` değil, üretim)
- `node_modules/cross-spawn/node_modules/isexe` kaydı kalktı (tek kopya, üst düzeyde)
- `node_modules/which/node_modules/isexe` → 3.1.5, `dev: true` (yalnızca electron-builder aracı)

Ayrıca [README.md](../README.md) → **Sorun giderme** tablosuna iki satır eklendi
(isexe hatası ve `EBUSY … app.asar` kilidi).

---

## 4. Doğrulama

Yeni paket, çalışma alanı dışındaki bir klasöre üretildi ve gerçekten çalıştırıldı:

| Kontrol | Sonuç |
| --- | --- |
| `app.asar` girdi sayısı | 1911 |
| `node_modules/isexe` içeriği | `index.js`, `mode.js`, `windows.js` **var** |
| `IDMS.exe` açılışı | pencere açıldı, başlık: `IDMS2` |
| Yerel köprü | `GET http://127.0.0.1:9789/info` → `200 {"app":"IDMS","version":"1.0.0","protocol":2,...}` |
| Hata penceresi | yok |

asar içeriğini denetlemek için kullanılan komut:

```powershell
node -e "const a=require('@electron/asar');console.log(a.listPackage('resources/app.asar').filter(p=>/isexe/i.test(p)).join('\n'))"
```

---

## 5. Derleme sırasında karşılaşılan ikinci sorun: `EBUSY / EPERM … app.asar`

Derleme bazen şu hatayla düşüyordu:

```
EBUSY: resource busy or locked, unlink '...\win-unpacked\resources\app.asar'
EPERM: operation not permitted, rename 'win-unpacked.tmp' -> 'win-unpacked'
```

**Sebep:** Çıktı klasöründeki `.asar` dosyaları başka bir süreç tarafından açık
tutuluyordu. Windows'ta açık bir dosya silinemez/yeniden adlandırılamaz; electron-builder
da her derlemede `win-unpacked` klasörünü boşaltıp `.tmp` klasörünü yeniden
adlandırdığı için bu kilit derlemeyi düşürüyor.

Bunu doğrulayan test (kilitli dosya yalnızca `.asar`'dı, `.js` ve `.txt` serbestti):

```powershell
[System.IO.File]::Open((Resolve-Path 'resources\app.asar'),'Open','Read','None')
# -> IOException: dosya başka bir işlem tarafından kullanılıyor
```

**Çözüm:** Derleme çıktısını, asar dosyaları taranan/kilitlenen klasörün dışına verin:

```powershell
npx electron-builder --win --config.directories.output=C:\idms-build
```

Ayrıca `dist/` içinde eski bir `win-unpacked` varken aynı klasöre derleme yapmak da
kilit hatasını tetikler; gerekiyorsa önce o klasörü boşaltın.

---

## 6. Temizlik kaydı

Aşağıdaki bozuk/deneme klasörleri silindi:

| Yol | Not |
| --- | --- |
| `C:\idms-build` | bozuk paket (00:11), silindi |
| `C:\idms-build2` | bozuk paket (00:23), silindi |
| `C:\idms-build3\win-unpacked.tmp` | yarım kalan derleme artığı, silindi |
| `dist-noasar`, `dist-repro` | başarısız deneme derlemeleri, silindi |
| `dist-diagnostic`, `dist-ready` | eski tanı çıktıları, silindi |
| `dist-locktest` | asar kilit testi dosyaları, silindi |
| `dist\win-unpacked.tmp` | yarım kalan derleme artığı, silindi |
| `C:\idms-tmp-build` | geçici derleme alanı, silindi |

Korunanlar:

- `C:\idms-build3\IDMS Setup 1.0.0.exe` — kurulum paketi (NSIS, x64, 108 MB)
- `C:\idms-build3\win-unpacked\IDMS.exe` — kurulumsuz çalışan sürüm
- `dist/` — eski ama sağlam sürüm (kodu güncel değil)

---

## 7. Tekrarını önlemek için kontrol listesi

1. `package.json` içinde `isexe: ^2.0.0` **kalsın**. Kaldırılırsa aynı hata geri gelir.
2. `npm install` sonrası `npm ls isexe` çıktısı şöyle olmalı:
   ```
   └── isexe@2.0.0
   ```
   (3.x yalnızca `which@5 → isexe@3.1.5` altında, `dev` olarak görünmeli.)
3. `npm run dist` sonrası paket kontrolü:
   ```powershell
   node -e "const a=require('@electron/asar');const l=a.listPackage('dist/win-unpacked/resources/app.asar');console.log(l.length, l.filter(p=>/isexe/i.test(p)).length)"
   ```
   Beklenen: ~1911 girdi ve `isexe` için **5** girdi (`index.js` dahil).
4. Yeni sürümü yayınlamadan önce `win-unpacked\IDMS.exe`'yi doğrudan çalıştırıp
   pencere açıldığını doğrulayın; kurulum paketi tek başına test sayılmaz.
5. Derleme `EBUSY/EPERM` ile düşerse çıktı klasörünü değiştirin; `node_modules`'ü
   silip yeniden kurmak gerekmez.
