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
- **Yüzen IDMS paneli** — sayfada video/ses oynarken sağ üst köşede duran
  küçük "IDMS" rozeti; tıklayınca Video / Ses / Formatlar seçenekleri açılır.
  Panel sayfanın içinde çizilir (ayrı pencere yok), odağı çalmaz ve yalnızca o
  tarayıcı sekmesinde görünür (Ayarlar → Eklenti → Yüzen panel)
- **IDM tarzı indirme pencereleri** — indirmeden önce **Dosya İndirme Bilgisi**
  (URL, kategori, kayıt yolu, kategori için yolu hatırla, açıklama, boyut, önizleme),
  indirme sırasında **ilerleme ve bağlantılar** (durum, hız, kalan süre, devam
  özelliği, segment çubuğu/tablosu, duraklat/iptal, hız sınırı), bitince
  **İndirme tamamlandı** (Aç / Birlikte aç / Klasörü aç) ve aynı bağlantı
  yeniden eklenince **Aynı indirme bağlantısı** (numaralı kopya / üzerine yaz /
  devam et) seçimi
- **Sosyal medya** — yt-dlp ile YouTube, Instagram, Facebook, Reddit, TikTok,
  X/Twitter, Vimeo, Twitch, **Kick**, Dailymotion, SoundCloud, Pinterest, VK,
  Bilibili… ; format seçim ekranı, çerez aktarımı, ses/video tercihi
- **Torrent** — WebTorrent ile magnet/.torrent; DHT/uTP, hız sınırı, tohum oranı
- **Bildirimler** — indirme **öncesi** (onay penceresi/eski bildirim), **sırasında**
  (ilerleme penceresi, %25/%50/%75), **sonunda** (tamamlandı penceresi, başarı/hata)
  sistem bildirimi + uygulama içi bildirim yığını
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
npm run dist       # derleme + ikon + eklenti + electron-builder ile Windows NSIS kurucusu
```

### Motor testleri (Electron gerekmez)

```powershell
node scripts\test-engine.mjs          # tüm testler
node scripts\test-engine.mjs engine   # tek dosya filtresi
```

Kapsam: URL sorgulama (probe), çok segmentli indirme + SHA256 bütünlüğü, kuyruk
eşzamanlılığı, duraklat→devam + SHA256, onay akışı, zamanlama, eklenti köprüsü
(HTTP `/info` `/pair` `/rpc` `/status`; CORS + token + köken denetimi, hatalı/doğru
kod, revoke, yüzen panel istekleri yalnızca eşleşmiş eklenti kökeninden).

Playwright (`npm run test:ext`) gerçek Chromium'a eklentiyi yükleyip uçtan uca
eşleştirme, ağ algılama, bağlantı yakalama, indirme devralma ve sayfa içi yüzen
paneli (rozet, kalite kartı, indirme satırı) doğrular.

## Tarayıcı eklentisi kurulumu

Önce uygulamayı bir kez çalıştırın; yerel köprü (HTTP + WebSocket) 9789–9798 arası
bir portta `127.0.0.1` üzerinde açılır. Sonra eklentiyi yükleyin:

1. **Eşleştirme kodunu alın** — Ayarlar → Eklenti sekmesi. Kod 6 haneli rastgeledir
   (test ortamında `TEST01`); “Yeni kod” ile değiştirebilirsiniz.
2. **Chrome / Edge / Brave (MV3)**
   - `chrome://extensions` → **Geliştirici modu** → **Paketlenmemiş yükleyici**
   - `extension/chromium` klasörünü seçin
3. **Firefox / Zen Browser (MV3)** — kalıcı kurulum
   - Ayarlar → Eklenti → **Firefox / Zen Browser** kartında kurulu tarayıcı
     profilleri listelenir; **Kur** düğmesine basın.
   - Uygulama `extension/gecko` içeriğini `idms2@idms2.app.xpi` olarak profile
     yazar ve o profilde `xpinstall.signatures.required=false` ile
     `extensions.autoDisableScopes=0` ayarlarını yapar (Gecko tabanlı tarayıcılar
     imzasız ve profile bırakılan eklentileri aksi halde yüklemez).
   - Tarayıcıyı yeniden başlatın; eklenti `about:addons` listesinde görünür ve
     her açılışta yüklenir. **Kaldır** aynı ayarları ve XPI'yi temizler.
   - Elle/geçici kurulum: `about:debugging#/runtime/this-firefox` → **Geçici
     eklentiyi yükle** → `extension/gecko/manifest.json` (tarayıcı kapanınca silinir).
   - Firefox/Zen MV3'te site erişimi varsayılan olarak sorulur; eklentiye
     **Tüm sitelere erişim** iznini verin (webRequest algılama ve indirme
     devralma için gerekir).
4. **Eklentiye girin** — araç çubuğu simgesi → açılan popup'a kodu yazın →
   **Eşleştir**. “Bağlı” görününce eklenti token alır; sonraki açılışlarda kod
   gerekmez.

Güvenlik: eşleştirme kodu yalnızca `chrome-extension://` / `moz-extension://`
kökenine token verir; token sonrası `/rpc` ve `/status` çağrıları hem geçerli token
hem de yetkili eklenti kökeni ister. CORS yanıtları yalnızca eşleşmiş kökene açılır.
Ayarlar → Eklenti → **Eşleştirmeyi sıfırla** yeni token üretir ve tüm tarayıcıları
disconnect eder.

> **Güvenlik notu (Firefox/Zen):** Otomatik kurulum yalnızca seçilen tarayıcı
> profilinde imza denetimini ve sideload korumasını kapatır; bu, o profile elle
> bırakılan diğer imzasız eklentilerin de yüklenebilmesi anlamına gelir.
> **Kaldır** işlemi eklediği ayarları geri alır. Mümkünse eklentiyi imzalı olarak
> (AMO) dağıtmayı tercih edin.

Eklenti şunları yapar:

- **İndirme devralma** — Chrome/Firefox kendi indirmesini başlatınca iptal eder ve
  adresi IDMS'e aktarır (`Ayarlar → Eklenti → Tarayıcı indirmelerini devral`).
  Devralma, IDMS indirmeyi kabul ettikten **sonra** yapılır: uygulama kapalıysa,
  eşleştirme geçersizse ya da köprü yanıt vermezse tarayıcı indirmesi iptal
  edilmez; dosya tarayıcıda inmeye devam eder ve neden popup'ta bildirilir.
- **Bağlantı yakalama** — bilinen dosya uzantılı (`zip`, `mp4`, `pdf`, `exe`…) ve
  `download` öznitelikli bağlantılara tıklamayı durdurur, IDMS'e gönderir.
- **Sağ tık menüsü** — “IDMS ile indir” bağlantı, video/ses, görsel ve sayfa için.
- **Ağ gözetleme** — `webRequest` ile indirilebilir içerikleri (video/ses/akış/dosya)
  algılar, popup listesinde gösterir.
- **Yüzen panel** — oynayan/üzerine gelinen video-ses algılanınca videonun sağ
  üst köşesine sabit bir “IDMS” rozeti çizer; ayrı bir masaüstü penceresi açmaz.
  Kalite listesi ve indirme uygulamadan istenir.

Video/ses oynayan bir sayfada videonun sağ üst köşesinde **IDMS** rozeti belirir.
Rozete tıklayınca açılan kartta IDM'nin yüzen paneli gibi **video kaliteleri**
(1080p/720p/480p…) ve **ses dosyaları** (M4A/Opus…, ayrıca "Sadece ses (MP3)")
listelenir; her satır tek tıkla indirilir. Kaliteler iki kaynaktan gelir:
oynatıcının `<source>` listesi (anında, yt-dlp gerekmez) ve sosyal medya/
HLS-DASH yayınları için yt-dlp biçim listesi. Kart, satır sayısına göre büyür;
**Formatlar…** ayrıntılı seçim penceresini açar, **IDMS'i aç** ana pencereyi öne
getirir, **✕** paneli o medya için gizler. Kart başlığına tıklamak paneli
yeniden rozete küçültür. Panel **ayrı bir pencere değildir**: içerik betiği
tarafından sayfanın içinde (gölge DOM) çizilir, bu yüzden yalnızca o tarayıcı
sekmesinde yaşar ve başka uygulamaların üzerine çıkmaz; odağı çalmaz. Rozet
**videonun sağ üst köşesine** sabittir. Sayfa kaydırılırken panel gizlenir;
kaydırma durunca videonun sağ üst köşesinde geri gelir. Panel video
durduğunda/bitince, video görünümden çıkınca ya da sekme gizlenince kalkar. Instagram/X akışı gibi
sayfalarda oynatıcı `blob:` kullanır ve adres tek bir video değildir; rozet
videonun yanındaki **gönderi bağlantısını** (…/p/…, …/reel/…, …/reels/…,
…/status/…) bulup onu çözer, bulamazsa ham hata yerine "gönderi/video
sayfasını açın" notunu gösterir. Oynatıcı kendi **gölge DOM**'unda (Reddit'in
`<shreddit-player>`'ı gibi) olsa da rozet videoyu bulur: işaretçi olayının
`composedPath()`'i ve açık gölge köklerinin taranması kullanılır; oynatıcı
kabuğu değil videonun kendisi referans alınır. Oynatıcı tek bir `<source>`
gösterip kaliteleri gizli bir **HLS/DASH manifestinde** tutuyorsa (Reddit),
manifest oynatıcının ağ kayıtlarından ya da eklentinin ağ gözetlemesinden
bulunur ve yt-dlp ile çözülür; böylece
tüm video kaliteleri ve ayrı ses dosyaları listelenir. Manifest çözülemezse
oynatıcının `<source>` listesine düşülür. Ayarlar → Eklenti →
**Yüzen panel** ile kapatılır.

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
  extGecko.ts        Firefox/Zen profiline kalıcı eklenti kurulumu (XPI + user.js)
  zip.ts             Bağımlılıksız ZIP yazıcı (eklenti .xpi paketi)
  downloadWindows.ts IDM tarzı dört pencere (öncesi / ilerleme / tamamlandı / aynı URL)
  floatService.ts    Sayfa içi panelin uygulama tarafı: kalite listesi + indirme
  floatFormats.ts    Panelin kalite/ses listesi eşlemesi (<source> + yt-dlp biçimleri)
  ytdlp.ts           yt-dlp/ffmpeg bulucu ve çalıştırıcı
  torrent.ts         WebTorrent sarmalayıcı
  notify.ts          3 aşamalı bildirim (önce/sıra/sonra)
  store.ts           Ayarlar + indirme listesi kalıcılığı (atomik JSON)
src/preload/         contextBridge → window.idms
src/renderer/        React arayüzü (TR/EN, koyu/açık tema)
  src/windows/       IDM pencereleri: Dosya İndirme Bilgisi, ilerleme, tamamlandı, aynı URL
  download.html      Bu dört pencerenin ortak giriş sayfası (downloadWindow.tsx)
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
| Firefox/Zen'de eklenti görünmüyor | Ayarlar → Eklenti → **Firefox / Zen Browser** → profili seçip **Kur**, sonra tarayıcıyı yeniden başlatın; `about:debugging` ile yüklenen geçici eklenti tarayıcı kapanınca silinir |
| Bağlantı tıklaması yakalanmıyor | Eklentinin site erişimi iznini ve “Eklenti etkin” anahtarını kontrol edin. Uygulama kapalı ya da eşleştirme geçersizse tıklama **yutulmaz**: sayfada “indirme tarayıcıya bırakıldı” bildirimi çıkar ve dosyayı tarayıcı indirir |
| “yt-dlp bulunamadı” | `winget install yt-dlp` veya Ayarlar → Sosyal Medya → yolu elle verin |
| İndirme hemen hata veriyor | Sunucunun URL'sini kontrol edin; günlüğü `npm run dev` konsolundan izleyin |
| Port çakışması | Ayarlar → Eklenti → port (0 = otomatik; 9789–9798 taranır) |

## Dil notu

Uygulama arayazı ilk açılışta sistem diline göre TR/EN seçilir; kalıcı seçim
Ayarlar → Genel → Dil içindedir. Çeviri anahtarları `src/shared/i18n.ts` içindeki
`tr` ve `en` sözlüklerindedir.


