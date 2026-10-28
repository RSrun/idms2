'use strict'

/**
 * IDMS içerik betiği
 *
 *  1. Oynayan / üzerine gelinen video-ses öğesini ve ekran dikdörtgenini
 *     arka plana bildirir → masaüstü "IDMS" yüzen paneli konumlanır.
 *  2. Bilinen dosya uzantılı bağlantılara (ve `download` öznitelikli bağlantılara)
 *     tıklamayı yakalar, sayfayı terk etmeden IDMS'e gönderir.
 *  3. Kısa bir sayfa içi bildirim gösterir.
 *
 * Panelin kendisi web sayfasında değil, uygulamanın ayrı şeffaf penceresindedir;
 * burada yalnızca konum/medya bilgisi üretilir.
 */
;(() => {
  if (window.top !== window || window.__idmsContentLoaded) return
  window.__idmsContentLoaded = true
  try {
    document.documentElement.setAttribute('data-idms-ready', '1')
  } catch {
    /* belge henüz hazır değil */
  }

  const EXTRACTOR_HOST =
    /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com|vimeo\.com|reddit\.com|dailymotion\.com|twitch\.tv)$/i

  const DOWNLOAD_EXT =
    /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|msix|dmg|pkg|deb|rpm|apk|appx|pdf|docx?|xlsx?|pptx?|odt|ods|epub|torrent|mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus|wma|mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|m3u8|mpd)(?:[?#].*)?$/i

  const MEDIA_EXT =
    /\.(mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus|wma|mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|m3u8|mpd)(?:[?#].*)?$/i

  const STREAM_EXT = /\.(m3u8|mpd)(?:[?#].*)?$/i

  /**
   * Tek bir video/gönderi adresi deseni. Akış (blob:) oynatan sayfalarda
   * yt-dlp sayfa kökünü çözemez; videonun yakınındaki gerçek gönderi
   * bağlantısı (Instagram /p/, /reel/, X /status/, TikTok /video/… ) aranır.
   */
  const POST_PATH =
    /\/(?:p|reel|tv)\/[A-Za-z0-9_-]{5,}|\/status\/\d+|\/video\/\d+|\/videos?\/\d+|\/shorts\/[A-Za-z0-9_-]{5,}|\/embed\/[A-Za-z0-9_-]{5,}|\/clip\/[A-Za-z0-9_-]{4,}|\/comments\/[A-Za-z0-9]{4,}|\/watch\/?\?[^#]*\bv=\d+/i

  // -------------------------------------------------------------------------
  // Yardımcılar
  // -------------------------------------------------------------------------

  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg)
    } catch {
      /* eklenti güncellenmiş / bağlam kapanmış */
    }
  }

  const absolute = (url) => {
    if (!url) return ''
    try {
      return new URL(url, location.href).href
    } catch {
      return url
    }
  }

  const sourceOf = (el) => {
    const raw = el.currentSrc || el.src || ''
    if (raw) return absolute(raw)
    // <source> alt öğeleri (currentSrc genelde doludur, yine de bak)
    const src = el.querySelector('source[src]')
    return src ? absolute(src.getAttribute('src')) : ''
  }

  const isPlaying = (el) => !!el && !el.paused && !el.ended

  /**
   * Verilen nokta videonun kendi alanına mı düşüyor? Sayfanın yapışkan başlığı
   * gibi, videonun oynatıcı kabuğuna ait olmayan bir öğe üstünü örtüyorsa
   * false döner. Böylece rozet, başlık çubuğunun üzerine değil videonun
   * gerçekten görünen kısmına yerleşir.
   */
  function overMedia(el, node) {
    if (!node) return true
    if (node === el || el.contains(node) || node.contains(el)) return true
    // Oynatıcı kabuğu (kontrol çubuğu, kapak) videonun yakın atasıdır; body ve
    // html her şeyi kapsadığı için onlar hesaba katılmaz — yoksa sayfanın sabit
    // başlığı da "oynatıcının parçası" sayılırdı.
    let parent = el.parentElement
    for (let i = 0; i < 4 && parent && parent !== document.body; i++, parent = parent.parentElement) {
      if (parent === document.documentElement) break
      if (parent.contains(node)) return true
    }
    return false
  }

  /** Üstü örtülüyse (sabit başlık) rozetin üst kenarını örtünün altına indirir. */
  function clearTop(el, left, right, bottom, top) {
    const probeX = Math.round(Math.min(right - 8, Math.max(left + 8, right - 70)))
    let y = top
    for (let i = 0; i < 8; i++) {
      if (y + 24 > bottom) break
      if (overMedia(el, document.elementFromPoint(probeX, Math.round(y + 6)))) return y
      y += 26
    }
    return top
  }

  /** Medyanın görünüm alanında kalan parçası (CSS px). */
  function visiblePart(el) {
    const r = el.getBoundingClientRect()
    return {
      left: Math.max(0, r.left),
      right: Math.min(window.innerWidth, r.right),
      top: Math.max(0, r.top),
      bottom: Math.min(window.innerHeight, r.bottom)
    }
  }

  /** Rozet için yeterli görünür alan var mı (video ekrandan çıktı mı)? */
  function onScreen(el) {
    const p = visiblePart(el)
    return p.right - p.left >= 80 && p.bottom - p.top >= 48
  }

  /** Görünüm alanındaki medya öğesinin ekran (DIP) dikdörtgeni. */
  function screenRect(el) {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return null
    let originX
    let originY
    if (typeof window.mozInnerScreenX === 'number') {
      originX = window.mozInnerScreenX
      originY = window.mozInnerScreenY
    } else {
      originX = window.screenX + Math.max(0, (window.outerWidth - window.innerWidth) / 2)
      originY = window.screenY + Math.max(0, window.outerHeight - window.innerHeight)
    }

    // Ekran/görünüm dışına taşan kısımlar atılır: rozet yalnızca videonun
    // görünen parçasına yerleştirilir.
    const { left, right, top, bottom } = visiblePart(el)
    if (right - left < 8 || bottom - top < 8) return null

    const y = clearTop(el, left, right, bottom, top)
    const rect = {
      x: Math.round(originX + left),
      y: Math.round(originY + y),
      width: Math.round(right - left),
      height: Math.round(bottom - y)
    }
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
    return rect
  }

  function keyOf(el, url) {
    return `${location.href.split('#')[0]}|${url || el.tagName.toLowerCase()}|${el.id || ''}`.slice(0, 2000)
  }

  /**
   * Oynatıcının sunduğu alternatif dosyalar (<source> etiketleri). Panelde
   * IDM gibi "1080p / 720p / ses" listesi çıkarmak için kullanılır.
   */
  function sourcesOf(el) {
    const out = []
    const push = (raw, mime, label) => {
      const url = absolute(raw)
      if (!url || !/^https?:/i.test(url)) return
      if (out.some((s) => s.url === url)) return
      out.push({
        url,
        mime: (mime || '').slice(0, 80),
        label: (label || '').slice(0, 40)
      })
    }
    push(
      el.getAttribute('src'),
      el.getAttribute('type'),
      el.getAttribute('label') ||
        el.getAttribute('data-quality') ||
        el.getAttribute('data-res')
    )
    for (const s of el.querySelectorAll('source')) {
      push(
        s.getAttribute('src') || s.getAttribute('data-src'),
        s.getAttribute('type'),
        s.getAttribute('label') ||
          s.getAttribute('size') ||
          s.getAttribute('data-quality') ||
          s.getAttribute('data-res') ||
          s.getAttribute('title')
      )
    }
    return out.slice(0, 8)
  }

  /**
   * Videonun bulunduğu gönderi/video sayfasının adresi.
   *
   * Instagram akışı, X zaman tüneli gibi sayfalarda oynatıcı `blob:`
   * kullanır ve sayfa adresi tek bir video değildir; yt-dlp böyle bir adresi
   * çözemez. Video öğesinden yukarı doğru en fazla 12 ata içinde gönderi
   * bağlantısı aranır; bulunamazsa boş döner (panel kısa bir yönlendirme
   * gösterir).
   */
  function postUrlOf(el) {
    const here = location.href.split('#')[0]
    try {
      const u = new URL(here)
      if (POST_PATH.test(u.pathname + u.search)) return here
    } catch {
      /* geçersiz adres */
    }

    let node = el.parentElement
    for (let depth = 0; depth < 12 && node && node !== document.body; depth++) {
      const links = node.querySelectorAll('a[href]')
      if (links.length > 120) break
      for (const a of links) {
        let target
        try {
          target = new URL(a.getAttribute('href'), location.href)
        } catch {
          continue
        }
        if (target.protocol !== 'https:' && target.protocol !== 'http:') continue
        if (target.hostname !== location.hostname) continue
        if (!POST_PATH.test(target.pathname + target.search)) continue
        return target.href.split('#')[0]
      }
      node = node.parentElement
    }
    return ''
  }

  function mediaInfo(el, url) {
    return {
      url,
      pageUrl: postUrlOf(el) || location.href,
      title: el.title || el.getAttribute('aria-label') || document.title || url,
      pageTitle: document.title,
      kind: el.tagName === 'AUDIO' ? 'audio' : 'video',
      duration: Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null,
      direct: /^https?:/i.test(url) && !STREAM_EXT.test(url),
      needsExtractor: EXTRACTOR_HOST.test(location.hostname),
      sources: sourcesOf(el)
    }
  }

  // -------------------------------------------------------------------------
  // Yüzen panel bildirimi
  // -------------------------------------------------------------------------

  let active = null
  let lastKey = ''
  let lastRect = null
  let lastSentAt = 0
  let hovering = false
  let hideTimer = 0
  let visible = false

  /**
   * Rozet ilk göründüğü ekran noktasında sabit kalır: sayfa kaydırılınca
   * videoyla birlikte sürüklenmez, bu yüzden kaydırma yeni konum göndermez.
   * Video görünümden çıkınca panel gizlenir; geri gelince yeniden konumlanır.
   */
  function sendShow(el) {
    if (!el || !document.contains(el) || document.hidden) return
    const url = sourceOf(el)
    const key = keyOf(el, url)
    if (visible && key === lastKey && lastRect) {
      if (!onScreen(el)) sendHide()
      return
    }
    const rect = screenRect(el)
    if (!rect) {
      if (visible) sendHide()
      return
    }
    visible = true
    lastKey = key
    lastRect = rect
    lastSentAt = Date.now()
    send({ type: 'float', state: 'show', key, media: mediaInfo(el, url), rect })
  }

  /** Aynı noktada yeniden gönderir: uygulama yeniden başlarsa panel geri gelir. */
  function refreshShow() {
    if (!visible || !lastRect || !lastKey) return
    if (Date.now() - lastSentAt < 4000) return
    const el = active
    if (!el || !document.contains(el)) return
    lastSentAt = Date.now()
    send({
      type: 'float',
      state: 'show',
      key: lastKey,
      media: mediaInfo(el, sourceOf(el)),
      rect: lastRect
    })
  }

  function sendHide() {
    clearTimeout(hideTimer)
    hideTimer = 0
    if (!visible && !lastKey) return
    visible = false
    lastKey = ''
    lastRect = null
    send({ type: 'float', state: 'hide', key: '' })
  }

  function activate(el, force, hovered) {
    if (!(el instanceof HTMLMediaElement)) return
    active = el
    if (hovered) hovering = true
    clearTimeout(hideTimer)
    hideTimer = 0
    sendShow(el)
  }

  function scheduleHide(delay = 1400) {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = 0
      if (active && isPlaying(active)) return
      if (hovering) return
      sendHide()
      if (active && !isPlaying(active)) active = null
    }, delay)
  }

  // Medya oynatma olayları (tüm sayfa, capture)
  document.addEventListener(
    'play',
    (ev) => {
      if (ev.target instanceof HTMLMediaElement) activate(ev.target, true)
    },
    true
  )
  document.addEventListener(
    'playing',
    (ev) => {
      if (ev.target instanceof HTMLMediaElement) activate(ev.target)
    },
    true
  )
  document.addEventListener(
    'pause',
    (ev) => {
      if (ev.target !== active) return
      // Kullanıcı rozete ulaşabilsin diye kısa bir süre daha görünür kalır.
      scheduleHide(2600)
    },
    true
  )
  document.addEventListener(
    'ended',
    () => {
      active = null
      sendHide()
    },
    true
  )
  document.addEventListener(
    'emptied',
    (ev) => {
      if (ev.target === active) {
        active = null
        sendHide()
      }
    },
    true
  )

  // İşaretçi medya üzerindeyken (oynatılmasa da) panel görünür kalsın
  document.addEventListener(
    'pointerover',
    (ev) => {
      const target = ev.target
      if (!(target instanceof Element)) return
      const media = target.closest('video, audio')
      if (!(media instanceof HTMLMediaElement)) return
      hovering = true
      activate(media, lastKey !== keyOf(media, sourceOf(media)), true)
    },
    true
  )

  document.addEventListener(
    'pointerout',
    (ev) => {
      const target = ev.target
      if (!(target instanceof Element)) return
      const media = target.closest('video, audio')
      if (!(media instanceof HTMLMediaElement)) return
      const to = ev.relatedTarget
      if (to instanceof Node && media.contains(to)) return
      hovering = false
      scheduleHide(1800)
    },
    true
  )

  // Rozet kaydırma sırasında yerinde kalır; yalnızca video görünümden
  // çıkınca gizlenir, pencere/tam ekran değişince yeniden konumlanır.
  const reposition = (force) => {
    if (!active) return
    if (!visible) {
      if (isPlaying(active) || hovering) sendShow(active)
      return
    }
    if (!onScreen(active)) {
      sendHide()
      return
    }
    if (force) {
      lastRect = null
      sendShow(active)
    }
  }
  window.addEventListener('scroll', () => reposition(false), { capture: true, passive: true })
  window.addEventListener('resize', () => setTimeout(() => reposition(true), 150), { passive: true })
  document.addEventListener('fullscreenchange', () => setTimeout(() => reposition(true), 150), true)

  setInterval(() => {
    if (!active || document.hidden) return
    if (!document.contains(active)) {
      active = null
      sendHide()
      return
    }
    if (isPlaying(active) || hovering) {
      sendShow(active)
      refreshShow()
    }
  }, 1000)

  /**
   * Betik yüklendiğinde zaten oynayan (autoplay) medyayı da yakala; aksi
   * hâlde panel ancak bir play/pointerover olayından sonra görünürdü.
   */
  function scanPlaying() {
    if (active && isPlaying(active)) return
    const playing = []
    for (const el of document.querySelectorAll('video, audio')) {
      if (!(el instanceof HTMLMediaElement) || !isPlaying(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      playing.push({ el, area: r.width * r.height })
    }
    if (!playing.length) return
    playing.sort((a, b) => b.area - a.area)
    activate(playing[0].el, true)
  }

  scanPlaying()
  setTimeout(scanPlaying, 900)

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sendHide()
  })
  window.addEventListener('pagehide', sendHide)
  window.addEventListener('beforeunload', sendHide)

  // -------------------------------------------------------------------------
  // Bağlantı tıklaması yakalama
  // -------------------------------------------------------------------------

  document.addEventListener(
    'click',
    (ev) => {
      if (ev.defaultPrevented || ev.button !== 0) return
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
      const target = ev.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return

      const href = absolute(anchor.href)
      if (!/^https?:/i.test(href)) return

      const hasDownload = anchor.hasAttribute('download')
      if (!hasDownload && !DOWNLOAD_EXT.test(href)) return

      // Sayfa içi çapa / aynı adres değilse yakala
      ev.preventDefault()
      ev.stopImmediatePropagation()

      const media = MEDIA_EXT.test(href)
      send({
        type: 'link-click',
        url: href,
        pageUrl: location.href,
        name: anchor.getAttribute('download') || '',
        media
      })
      toast(media ? 'Medya IDMS kuyruğuna eklendi' : 'İndirme IDMS kuyruğuna eklendi')
    },
    true
  )

  // -------------------------------------------------------------------------
  // Sayfa içi kısa bildirim
  // -------------------------------------------------------------------------

  let toastTimer = 0

  function toast(text) {
    try {
      let host = document.getElementById('idms-toast-host')
      if (!host) {
        host = document.createElement('div')
        host.id = 'idms-toast-host'
        host.className = 'idms-toast-host'
        document.documentElement.appendChild(host)
      }
      const root = host.shadowRoot || host.attachShadow({ mode: 'open' })
      root.innerHTML = ''
      const box = document.createElement('div')
      box.className = 'idms-toast'
      const mark = document.createElement('span')
      mark.className = 'idms-toast-mark'
      mark.textContent = 'IDMS'
      const label = document.createElement('span')
      label.textContent = text
      box.append(mark, label)
      root.append(box)

      const style = root.getElementById('idms-toast-style') || document.createElement('style')
      style.id = 'idms-toast-style'
      style.textContent = `
        .idms-toast {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 13px; border-radius: 10px;
          background: #14171f; color: #e8edf7;
          font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          border: 1px solid #333a4a;
          box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
          animation: idms-in .16s ease-out;
        }
        .idms-toast-mark {
          font-weight: 800; letter-spacing: .4px; font-size: 11px;
          color: #8db8ff; border: 1px solid #2f4a74; border-radius: 6px;
          padding: 2px 5px; background: #1d2c47;
        }
        @keyframes idms-in { from { opacity: 0; transform: translateY(6px) } }
      `
      if (!style.parentNode) root.append(style)

      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        try {
          root.innerHTML = ''
        } catch {
          /* yoksay */
        }
      }, 2600)
    } catch {
      /* bildirim gösterilemedi */
    }
  }
})()
