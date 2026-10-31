# Torrent hatası: `ERR_INVALID_ARG_TYPE ... arr2hex` (uint8-util 2.3.x uyumsuzluğu)

**Durum:** Çözüldü (sürüm 1.0.3) · **Etki:** Torrent ekleme — her magnet/.torrent denemesinde çökme
**Güncelleme (31.10):** Aynı hata eski `app.asar`'dan tekrar görüldü; bkz. bölüm 6. Düzeltilmiş paket
sürümü **1.0.2+**; 1.0.1 kurulum dosyası düzeltme öncesi ağaçtan üretilmiş olabilir.
**Bileşenler:** webtorrent 2.8.5, parse-torrent 11.0.24, uint8-util 2.3.2, Electron 37.10.3

---

## 1. Belirti

Uygulama açılırken ya da bir magnet bağlantısı eklenirken hata penceresi:

```
IDMS başlatılamadı

TypeError [ERR_INVALID_ARG_TYPE]: The first argument must be of type string or an instance
of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined
    at Buffer.from (node:buffer:325:9)
    at arr2hex (…/app.asar/node_modules/uint8-util/dist/src/node.js:12:41)
    at Torrent._onTorrentId (…/app.asar/node_modules/webtorrent/lib/torrent.js:281:23)
```

Hata `uncaughtException` yakalayıcısına düştüğü için başlık "IDMS başlatılamadı" olsa da
olay **torrent ekleme** anında gerçekleşiyor. Sonuç: torrent hiç başlamıyor.

---

## 2. Kök neden

`webtorrent` bir torrent kimliğini çözerken `uint8-util`'in `arr2hex()` fonksiyonunu
kullanıyor:

```js
// webtorrent/lib/torrent.js (2.8.5)
import { hash, arr2hex } from 'uint8-util'

async _onTorrentId (torrentId) {
  const parsedTorrent = await parseTorrent(torrentId)
  this.infoHash = parsedTorrent.infoHash
  this._debugId = arr2hex(parsedTorrent.infoHash).substring(0, 7)   // ← 281. satır
  …
}
```

`parse-torrent@11.0.24` `infoHash` alanını **hex string** olarak döndürüyor
(`infoHashBuffer` ayrıca Uint8Array olarak geliyor). Buna karşılık `uint8-util@2.3.x`
içinde `arr2hex` artık yalnızca byte dizileri kabul ediyor:

```js
// uint8-util 2.3.2 (dist/src/node.js)
export const arr2hex = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex')
```

String'in `.buffer` özelliği `undefined` olduğu için `Buffer.from(undefined)` çağrısı
`ERR_INVALID_ARG_TYPE` fırlatıyor.

**Neden oldu:** `uint8-util` paketi, `^2.2.5` aralığına **kırıcı bir değişikliği minor
sürüm olarak** yayınladı (2.3.0 → `arr2hex`/`arr2base` artık ArrayBufferView bekliyor).
`webtorrent@2.8.5` hâlâ string ile çağırdığı için semver aralığı içinde otomatik güncelleme
uygulamayı kırdı. Upstream'de aynı hata raporlandı:
[webtorrent-cli#365](https://github.com/webtorrent/webtorrent-cli/issues/365)
(webtorrent 2.8.5 + parse-torrent 11.0.24 + uint8-util 2.3.2; WebTorrent master'da
string işlemi kullanılarak düzeltilmiş, ancak 2.x için yayınlanmış düzeltme yok).

### Kanıt

```powershell
node --input-type=module -e "import WebTorrent from 'webtorrent';
const c=new WebTorrent({dht:false});
c.add('magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056')"
# uint8-util 2.3.2 -> TypeError [ERR_INVALID_ARG_TYPE]  (aynı stack)
```

`parse-torrent` çıktısı:

```
infoHash       = c9e15763f722f23e98a29decdfae341b98d53056   (string)
infoHashBuffer = Uint8Array(20)
```

---

## 3. Düzeltme

`uint8-util` 2.2.6'ya sabitlendi (hem doğrudan bağımlılık hem `overrides` ile, böylece
ağaçta tek kopya kalıyor):

```json
"overrides": {
  "uint8-util": "2.2.6"
},
"dependencies": {
  "isexe": "^2.0.0",
  "uint8-util": "2.2.6",
  ...
}
```

`npm install` sonrası:

```
node_modules/uint8-util                       -> 2.2.6   (tek kopya, üst düzey)
```

2.2.6'daki `arr2hex` string ve byte dizisi ile çalışır (eski, gevşek davranış), bu yüzden
`webtorrent` 2.x beklendiği gibi çalışır. `2.3.x`'e özel `compare` fonksiyonu ağaçtaki
hiçbir paket tarafından kullanılmıyor; `arr2text`, `concat`, `equal`, `hash` gibi
fonksiyonlar 2.2.6'da da mevcut. Bu nedenle geri sabitleme diğer bağımlılıkları bozmuyor.

> Alternatif (daha büyük değişiklik): webtorrent 3.x'e geçmek. Torrent API'si ve
> `utp` seçeneği değiştiği için 2.x + sabitleme tercih edildi.

---

## 4. Doğrulama

| Kontrol | Sonuç |
| --- | --- |
| `arr2hex('c9e1…')` | hata yok |
| `client.add(magnet)` (depo `node_modules`) | çökme yok, `infoHash` doğru |
| Aynı test, paketlenmiş `app.asar` içeriğiyle | çökme yok, `infoHash` doğru |
| `node scripts/test-engine.mjs` | 154 başarılı, 0 başarısız |
| Paketlenmiş uygulama | açılıyor, `GET /info` → `"version":"1.0.3"` |
| asar içeriği | `isexe` 5 dosya (v2.0.0), `uint8-util` 2.2.6 |

---

## 5. Kontrol listesi

1. `package.json` içinde `overrides.uint8-util = 2.2.6` **ve** `dependencies.uint8-util = 2.2.6` kalsın.
2. `npm install` sonrası `npm ls uint8-util` yalnızca `2.2.6` göstermeli, `2.3.x` görünmemeli.
3. Torrent değişikliği içeren sürümlerde yayın öncesi hızlı test:
   ```powershell
   node --input-type=module -e "import WebTorrent from 'webtorrent';
   const c=new WebTorrent({dht:false}); const t=c.add('magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056');
   setTimeout(()=>{console.log(t.infoHash);c.destroy(()=>process.exit(0))},1200)"
   ```
4. `webtorrent` 3.x'e geçilirse bu sabitleme kaldırılabilir; geçişte `utp`/`add()` imzaları
   ve yerel modül (`utp-native`, `node-datachannel`) seçenekleri yeniden kontrol edilmeli.

---

## 6. Aynı hatanın eski pakette tekrar görülmesi

Kaynak ağacı düzeltildikten sonra hata yeniden bildirildi. İnceleme sonucu **kod değil,
kurulu paket** eskiydi:

| Konum | `uint8-util` | Not |
| --- | --- | --- |
| `node_modules` (kaynak) | 2.2.6 | doğru |
| `%LOCALAPPDATA%\Programs\IDMS\resources\app.asar` (kurulu uygulama) | **2.3.2** | 1.0.0 kurulumu, 08:05 |
| `dist\IDMS\resources\app.asar` | **2.3.2** | 17:57 derlemesi, `npm install` (19:29) öncesi |
| `C:\idms-build3\portable-1.0.1\resources\app.asar` | 2.2.6 | 19:32, düzeltme sonrası |

Yani `overrides` yalnızca `npm install` anında etkilidir; **düzeltme öncesi üretilmiş
asar'lar 2.3.2 taşımaya devam eder**. Uygulama `Programs\IDMS` altındaki eski kurulumdan
başlatıldığı için hata sürüyordu.

### Alınan önlemler

1. `scripts/check-torrent-deps.mjs` eklendi: `node_modules` ağacında 2.2.x dışında bir
   `uint8-util` varsa **derlemeyi durdurur**; `--asar` ile paketlenmiş `app.asar`'ı da denetler.
2. `package.json` betikleri:
   ```json
   "check:deps": "node scripts/check-torrent-deps.mjs",
   "verify:build": "node scripts/check-torrent-deps.mjs --asar",
   "dist": "npm run check:deps && ... && electron-builder --win && npm run verify:build"
   ```
3. Yeni sürüm kurulmadan eski `Programs\IDMS` kopyası çalıştırılmamalı; güncelleme
   yalnızca yeni `IDMS Setup x.y.z.exe` ile yapılır.

### Hızlı denetim

```powershell
npm run check:deps          # kaynak ağacı
npm run verify:build        # dist\win-unpacked\resources\app.asar
```
