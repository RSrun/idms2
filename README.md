# idms — IDM benzeri indirme yöneticisi

Electron + TypeScript ile yazılmış, IDM (Internet Download Manager) tarzı bir indirme
yöneticisi. Çok segmentli HTTP indirme, torrent, tarayıcı eklentisi (Chrome/Edge/Firefox)
ve sosyal medya video/ses indirmesi tek uygulamada.

**Arayüz Türkçe/İngilizce çift dilli** (Ayarlar → Dil ile değişir).

## Özellikler

- **Çok segmentli HTTP indirme** — aynı dosyaya paralel bağlantılar (Range), hız sınırı,
  kuyruk + eşzamanlılık sınırı, duraklat/devam, otomatik yeniden deneme
- **Tarayıcı eklentisi** — Chromium ve Firefox (MV3): tarayıcı indirmelerini devralır
  (iptal → IDMS), bilinen dosya uzantılı bağlantı tıklamalarını yakalar, sağ tık menüsü
  (“IDMS ile indir”: bağlantı / medya / görsel / sayfa), webRequest ile indirilebilir
  içerik algılama ve popup listesi
- **Yüzen IDMS paneli** — sayfada video/ses oynarken oynatıcının üzerinde her zaman
  en üstte duran küçük "IDMS" rozeti; tıklayınca Video / Ses / Formatlar
  seçenekleri açılır, panel odağı çalmaz (Ayarlar → Eklenti → Yüzen panel)
- **Sosyal medya** — yt-dlp ile YouTube, Instagram, Facebook, Reddit, TikTok, X… ;
  format seçim ekranı, çerez aktarımı, ses/video tercihi
- **Torrent** — WebTorrent ile magnet/.torrent; DHT/uTP, hız sınırı, tohum oranı
- **Bildirimler** — indirme **öncesi** (onay), **sırasında** (%25/%50/%75),
  **sonunda** (başarı/hata) sistem bildirimi + uygulama içi bildirim yığını
- **Ekstralar** — pano izleme, magnet: protokolü, tepsi simgesi, benzersiz dosya adı
  (`dosya (1).ext`), kategori algılama (video/ses/arşiv/program/belge), zamanlanmış
  indirme, TR/EN koyu & açık tema

## Gereksinimler

- Node.js 20+ ve npm 10+
- Windows (paketleme NSIS `.exe` içindir; `npm run dev` diğer platformlarda da çalışır)

## Kurulum ve çalıştırma

```powershell
npm install        # bağımlılıklar (native modüller için install script onayı istenir)
npm run dev        # geliştirme modu (electron-vite)
```

Diğer komutlar:

```powershell
npm run build      # out/ altına üretim derlemesi
npm run start      # derlenmiş sürümü çalıştır
npm run typecheck  # tsc --noEmit (main + renderer)
npm run icons      # prosedürel PNG ikonlarını üretir (build/resources/icon.png)
npm run ext        # extension/shared → chromium + firefox + gecko hedeflerini sıfırdan üretir
npm run dist       # ikon + eklenti + electron-builder ile Windows NSIS kurucusu
```

### Motor testleri (Electron gerekmez)

```powershell
node scripts\test-engine.mjs          # tüm testler
node scripts\test-engine.mjs engine   # tek dosya filtresi
```

Kapsam: URL sorgulama (probe), çok segmentli indirme + SHA256 bütünlüğü, kuyruk
eşzamanlılığı, duraklat→devam + SHA256, onay akışı, zamanlama, eklenti köprüsü
(HTTP `/info` `/pair` `/rpc` `/status`; CORS + token + köken denetimi, hatalı/doğru
kod, revoke, yüzen panel yalnızca eşleşmiş eklenti kökeninden).

Playwright (`npm run test:ext`) gerçek Chromium'a eklentiyi yükleyip uçtan uca
eşleştirme, ağ algılama, bağlantı yakalama, indirme devralma ve yüzen panel
bildirimini doğrular.

## Tarayıcı eklentisi kurulumu

Önce uygulamayı bir kez çalıştırın; yerel köprü (HTTP + WebSocket) 9789–9798 arası
bir portta `127.0.0.1` üzerinde açılır. Sonra eklentiyi yükleyin:

1. **Eşleştirme kodunu alın** — Ayarlar → Eklenti sekmesi. Kod 6 haneli rastgeledir
   (test ortamında `TEST01`); “Yeni kod” ile değiştirebilirsiniz.
2. **Chrome / Edge / Brave (MV3)**
   - `chrome://extensions` → **Geliştirici modu** → **Paketlenmemiş yükleyici**
   - `extension/chromium` klasörünü seçin
3. **Firefox (MV3)**
   - `about:debugging#/runtime/this-firefox` → **Geçici eklentiyi yükle**
   - `extension/gecko/manifest.json` (veya `extension/firefox/manifest.json`) dosyasını seçin
   - Firefox MV3'te site erişimi varsayılan olarak sorulur; eklentiye **Tüm sitelere
     erişim** iznini verin (webRequest algılama ve indirme devralma için gerekir)
4. **Eklentiye girin** — araç çubuğu simgesi → açılan popup'a kodu yazın →
   **Eşleştir**. “Bağlı” görününce eklenti token alır; sonraki açılışlarda kod
   gerekmez.

Güvenlik: eşleştirme kodu yalnızca `chrome-extension://` / `moz-extension://`
kökenine token verir; token sonrası `/rpc` ve `/status` çağrıları hem geçerli token
hem de yetkili eklenti kökeni ister. CORS yanıtları yalnızca eşleşmiş kökene açılır.
Ayarlar → Eklenti → **Eşleştirmeyi sıfırla** yeni token üretir ve tüm tarayıcıları
disconnect eder.

Eklenti şunları yapar:

- **İndirme devralma** — Chrome/Firefox kendi indirmesini başlatınca iptal eder ve
  adresi IDMS'e aktarır (`Ayarlar → Eklenti → Tarayıcı indirmelerini devral`).
- **Bağlantı yakalama** — bilinen dosya uzantılı (`zip`, `mp4`, `pdf`, `exe`…) ve
  `download` öznitelikli bağlantılara tıklamayı durdurur, IDMS'e gönderir.
- **Sağ tık menüsü** — “IDMS ile indir” bağlantı, video/ses, görsel ve sayfa için.
- **Ağ gözetleme** — `webRequest` ile indirilebilir içerikleri (video/ses/akış/dosya)
  algılar, popup listesinde gösterir.
- **Yüzen panel** — oynayan/üzerine gelinen video-ses öğesinin ekran dikdörtgenini
  uygulamaya bildirir.

Video/ses oynayan bir sayfada oynatıcının sağ üstünde **IDMS** rozeti belirir.
Rozete tıklayınca açılan kartta IDM'nin yüzen paneli gibi **video kaliteleri**
(1080p/720p/480p…) ve **ses dosyaları** (M4A/Opus…, ayrıca "Sadece ses (MP3)")
listelenir; her satır tek tıkla indirilir. Kaliteler iki kaynaktan gelir:
oynatıcının `<source>` listesi (anında, yt-dlp gerekmez) ve sosyal medya/
HLS-DASH yayınları için yt-dlp biçim listesi. Kart, satır sayısına göre büyür;
**Formatlar…** ayrıntılı seçim penceresini açar, **IDMS'i aç** ana pencereyi öne
getirir, **✕** paneli o medya için gizler. Kart başlığına tıklamak paneli
yeniden rozete küçültür. Panel ayrı bir şeffaf penceredir,
odağı çalmaz ve tam ekran videonun üzerinde de görünür. Rozet, videonun
**görünen** parçasına yerleşir: sayfanın yapışkan başlığı videonun üstünü
örtüyorsa başlığın altına iner, video rozetten darsa ortalanır. Kaydırma
sırasında rozet **ekranda sabit kalır** (videoyla birlikte sürüklenmez);
video tamamen görünümden çıkınca panel gizlenir. Instagram/X akışı gibi
sayfalarda oynatıcı `blob:` kullanır ve adres tek bir video değildir; rozet
videonun yanındaki **gönderi bağlantısını** (…/p/…, …/reel/…, …/status/…)
bulup onu çözer, bulamazsa ham hata yerine "gönderi/video sayfasını açın"
notunu gösterir. Ayarlar → Eklenti → **Yüzen panel** ile kapatılır.

> Uygulama kapalıyken eklenti yeniden bağlanmayı dener; port bulamazsa 9789'dan
> başlayıp 9798'e kadar tarar. Eşleştirme sıfırlanırsa eklenti yeni kodla yeniden
> eşleşir.

## Sosyal medya indirmesi (yt-dlp)

Ayarlar → Sosyal Medya:

- **yt-dlp yolu** boşsa uygulama `PATH`, bilinen kurulum konumları ve kullanıcı
  klasörlerinde `yt-dlp(.exe)` arar. Yoksa elle yol verin: `winget install yt-dlp`
- **ffmpeg** aynı şekilde aranır (birleştirilmiş ses+video için önerilir)
- **Çerezler** açıkken tarayıcı çerezleri geçici Netscape dosyasına aktarılır
  (giriş gerektiren içerik için)

Uygulamaya bir video bağlantısı yapıştırın veya eklentinin yakaladığı medyayı seçin;
format listesi açılır, seçince ilerleme bildirimleri başlar.

## Torrent

Ayarlar → Torrent: kayıt klasörü, port, eşzamanlı torrent sayısı, hız sınırı, tohum oranı.
`magnet:` bağlantıları varsayılan uygulamaya bağlanır; uygulama içinden `.torrent`
dosyası da açılabilir.

## Proje yapısı

```
src/main/            Electron ana süreç
  engine/            probe.ts (URL sorgulama), segment.ts (segmentli indirme),
                     manager.ts (kuyruk/durum makinesi)
  extServer.ts       Yerel köprü: HTTP (/info /pair /rpc /status) + WS + token/CORS
  floatPanel.ts      Yüzen “IDMS” paneli (şeffaf, odağı çalmayan pencere)
  floatFormats.ts    Panelin kalite/ses listesi eşlemesi (<source> + yt-dlp biçimleri)
  ytdlp.ts           yt-dlp/ffmpeg bulucu ve çalıştırıcı
  torrent.ts         WebTorrent sarmalayıcı
  notify.ts          3 aşamalı bildirim (önce/sıra/sonra)
  store.ts           Ayarlar + indirme listesi kalıcılığı (atomik JSON)
src/preload/         contextBridge → window.idms
src/renderer/        React arayüzü (TR/EN, koyu/açık tema)
src/shared/          Türler + i18n sözlükleri
extension/shared/    Eklenti kaynağı (build ile chromium/firefox/gecko'ya kopyalanır)
extension/manifests/ Hedefe özel manifestler (chromium.json, firefox.json)
tests/               Motor testleri (esbuild ile derlenir, Electron gerekmez)
scripts/             build-extension, make-icons, test-engine
```

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| Eklenti bağlanmıyor | Uygulamanın açık olduğunu doğrulayın (Ayarlar → Eklenti: “Çalışıyor”, port görünür); kodu popup'a yeniden yazın |
| Eklenti “Eşleştirme geçersiz” diyor | IDMS'te **Eşleştirmeyi sıfırla** → yeni kodu popup'a girin |
| Bağlantı tıklaması yakalanmıyor | Eklentinin site erişimi iznini ve “Eklenti etkin” anahtarını kontrol edin |
| “yt-dlp bulunamadı” | `winget install yt-dlp` veya Ayarlar → Sosyal Medya → yolu elle verin |
| İndirme hemen hata veriyor | Sunucunun URL'sini kontrol edin; günlüğü `npm run dev` konsolundan izleyin |
| Port çakışması | Ayarlar → Eklenti → port (0 = otomatik; 9789–9798 taranır) |

## Dil notu

Uygulama arayazı ilk açılışta sistem diline göre TR/EN seçilir; kalıcı seçim
Ayarlar → Genel → Dil içindedir. Çeviri anahtarları `src/shared/i18n.ts` içindeki
`tr` ve `en` sözlüklerindedir.


