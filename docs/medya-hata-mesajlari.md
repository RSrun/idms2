# Medya indirme: ham yt-dlp hata metni ve kaybolan oturum çerezleri

**Durum:** Çözüldü (sürüm 1.0.4) · **Etki:** Reddit/Instagram gibi giriş isteyen sitelerde medya penceresi
**Bileşenler:** `media:probe` (src/main/index.ts), `YtdlpRunner.probe`, `MediaDialog`, `classifyProbeError`

---

## 1. Belirti

Reddit'te bir videoyu “Formatlar…” ile açınca medya penceresinde ham yt-dlp çıktısı:

```
ERROR: [Reddit] 1xke97q: Account authentication is required. Use --cookies-from-browser
or --cookies for the authentication. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ#...
```

Kullanıcıya ne yapacağını söyleyen bir mesaj yok; ayrıca “İndir” de çalışmıyor.

---

## 2. Kök nedenler

### 2.1 Ham hata metni doğrudan arayüze gidiyordu

`ytdlp.probe()` başarısız olduğunda `MediaProbeResult.error` alanına yt-dlp'nin **stderr**
metnini koyuyor. Yüzen panel bu metni `probeErrorNote()` ile çeviriyordu, ancak
`media:probe` IPC'si sonucu olduğu gibi döndürüyordu; `MediaDialog` da `res.error`'ı
doğrudan gösteriyordu.

### 2.2 “rate-limit + login” mesajı yanlış sınıflanıyordu

`classifyProbeError()` önce rate-limit kalıbını deniyordu. Instagram'ın
“Requested content is not available, rate-limit reached or login required” mesajı bu yüzden
`rateLimit` dönüyor, çözümü çerez olan bir durumda “birkaç saniye sonra deneyin” gibi
yanıltıcı bir öneri çıkıyordu (`tests/engine.test.ts` bu yüzden kırmızıydı).

### 2.3 Çerezler medya penceresine taşınmıyordu

Eklenti/yüzen panel sayfanın oturum çerezlerini toplayıp `FloatMediaInfo.cookies` ile
gönderiyor; yüzen paneldeki kalite listesi bunları yt-dlp'ye veriyordu. Ancak
“Formatlar…” ile açılan `MediaDialog` yalnızca `url/pageUrl/title` alıyor,
`probeMedia(url, pageUrl)` çağrısında **çerezleri düşürüyordu**. Reddit gibi sitelerde
sonuç: “Account authentication is required”.

> Not: `cookiesBrowser()` tarayıcı açıkken (`lockfile`) bilinçli olarak `undefined` döner —
> Chrome/Edge çerez veritabanı kilitlidir. Bu durumda tek kaynak eklentinin gönderdiği
> çerezlerdir; aktarılmadığında oturum bilgisi hiç gitmiyordu.

---

## 3. Düzeltme

1. **Sınıflandırma sırası** (`src/main/floatFormats.ts`): oturum/çerez kalıpları artık
   rate-limit'ten **önce** denenir. Saf istek sınırı mesajları (`429`, “try again later”)
   yine `rateLimit` kalır.
2. **`media:probe`** (`src/main/index.ts`): hata varsa ham metin `console.warn` ile günlüğe
   yazılır, arayüze `mediaErrorNote()` çıktısı döner:
   - `login` → “Giriş gerektiren içerik: Ayarlar → Sosyal medyadan çerez aktarımını açın.”
   - `unsupported` / `rateLimit` / `unavailable` → ilgili kısa nota
   - bilinmeyen → “Kalite listesi okunamadı”
3. **İndirme hataları** (`runMediaDownload`): bilinen yt-dlp hataları çevrilmiş metinle
   `manager.externalError()`'a yazılır; ham metin günlükte kalır.
4. **Çerez aktarımı** (`src/renderer/src/App.tsx`, `MediaDialog.tsx`): `open-media`
   olayındaki `cookies` artık diyalog durumuna ve oradan `probeMedia` / `downloadMedia`
   çağrılarına taşınıyor.
5. `float.rateLimit` metni YouTube'a özel olmaktan çıkarıldı (site adı anılmıyor).

---

## 4. Doğrulama

| Kontrol | Sonuç |
| --- | --- |
| `classifyProbeError('[Reddit] … Account authentication is required')` | `login` |
| `classifyProbeError('… rate-limit reached or login required')` | `login` |
| `classifyProbeError('HTTP Error 429: Too Many Requests')` | `rateLimit` |
| `npm run typecheck` | temiz |
| `node scripts/test-engine.mjs` | 155 başarılı, 0 başarısız |
| Medya penceresinde hata | ham metin yok, çerez yönlendirmesi var |

Gerçek Reddit indirmesi için eklentinin sayfa çerezlerini toplaması (site erişim izni) ve
`Ayarlar → Sosyal medya → Tarayıcı çerezlerini aktar` seçeneğinin açık olması gerekir.
