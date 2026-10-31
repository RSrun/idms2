# Torrent hatası: `Cannot add duplicate torrent …`

**Durum:** Çözüldü (sürüm 1.0.3) · **Etki:** Aynı torrent'i ikinci kez eklemek
**Bileşenler:** webtorrent 2.8.5, TorrentManager (`src/main/torrent.ts`), TorrentDialog

---

## 1. Belirti

Aynı magnet / `.torrent` ikinci kez eklenince torrent penceresinde ham hata:

```
Error invoking remote method 'torrent:add': Error: Cannot add duplicate torrent
d69d80365bd21221ecae16c4b0fe37f2d1e3385f
```

Torrent zaten indiriliyordu; yeni bir şey eklenmiyor, kullanıcıya da "zaten var" bilgisi
verilmiyordu.

---

## 2. Kök neden

`webtorrent@2.8.5` aynı infoHash'i ikinci kez `client.add()` ile görünce yeni `Torrent`
nesnesini bilerek yok eder (`index.js` → `onInfoHash`):

```js
if (t.infoHash === torrent.infoHash && t !== torrent) {
  torrent._destroy(new Error(`Cannot add duplicate torrent ${torrent.infoHash}`))
  ontorrent(t)          // mevcut torrent callback'e verilir
  return
}
```

`TorrentManager.add()` bu hatayı `t.on('error')` üzerinden yakalayıp promise'i
reddediyordu; IPC de hatayı doğrudan renderer'a fırlatıyordu. Oysa "zaten ekli" bir hata
değil, **idempotent** bir durumdur: mevcut kayıt dönmeliydi.

Ek olarak `add()` içindeki 30 saniyelik "metadata bekleme" zamanlayıcısı promise
çözüldükten sonra da temizlenmiyordu (test süreçlerini ve kapanışı gereksiz bekletiyordu).

---

## 3. Düzeltme

### 3.1 `TorrentManager` (src/main/torrent.ts)

- `add()` artık önce `client.get(input)` ile **etkin torrenti** arar:
  - kayıt (`ActiveTorrent`) varsa → `{ id: mevcutId, duplicate: true }`
  - istemcide var ama kaydı yoksa (yarıda kalmış ekleme) → sahiplenilir
- Eşzamanlı iki ekleme yarışırsa webtorrent'in "duplicate" hatası yakalanır ve
  mevcut kayda dönülür.
- `track()` yardımcısına taşındı: kayıt + ilerleme dinleyicileri tek yerde.
- `findTorrent()` yok edilmiş (`destroyed`) torrentleri yok sayar.
- 30 sn'lik zamanlayıcı `finish()` içinde `clearTimeout` ile temizlenir.

### 3.2 IPC (`src/main/index.ts`)

- `torrent:add`: `duplicate` ise **yeni indirme kaydı açılmaz**, `torrentLinks`
  üzerinden mevcut indirme kimliği döner (`duplicate: true`).
- `addMagnet()` (magnet protokolü / ikinci örnek): `duplicate` ise pencere öne alınır,
  liste şişmez.

### 3.3 Arayüz (`src/renderer/src/dialogs/TorrentDialog.tsx`)

- `duplicate` yanıtı hata değil bilgi olarak gösterilir:
  “Bu torrent zaten listede; mevcut indirme seçildi.” (`torrent.duplicate` i18n anahtarı)
- Mevcut indirme `onAdded` ile seçilir; kullanıcı hangi kaydın kastedildiğini görür.

---

## 4. Doğrulama

`npm run test:torrent` → `scripts/test-torrent-dedupe.mjs`

Gerçek `TorrentManager` + gerçek webtorrent (DHT/LSD/UPnP kapalı, ağ gerekmez) ile:

| Kontrol | Sonuç |
| --- | --- |
| İlk ekleme yeni kayıt açar (`duplicate: false`) | ✓ |
| İkinci ekleme hata vermez (`duplicate: true`) | ✓ |
| İkinci ekleme aynı kimliği döndürür | ✓ |
| Etkin torrent sayısı 1 kalır | ✓ |
| Torrent adı okunur (`ornek.txt`) | ✓ |

Test, `electron` modülünü sahte bir stub ile değiştirir (TorrentManager yalnızca
`registerMagnetProtocol` içinde `app` kullanır).
