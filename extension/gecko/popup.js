'use strict'

const api = typeof browser !== 'undefined' ? browser : chrome

// IDMS tarayıcı eklentisi — popup

const $ = (id) => document.getElementById(id)

let STATE = null
let refreshTimer = 0

async function send(message) {
  try {
    const res = await api.runtime.sendMessage(message)
    return res === undefined ? { ok: false, error: 'yanıt yok' } : res
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

function fmtBytes(n) {
  const size = Number(n) || 0
  if (size <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log2(size) / 10))
  const v = size / Math.pow(2, i * 10)
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[i]}`
}

function show(el, on) {
  if (el) el.hidden = !on
}

function setHint(text, tone) {
  const hint = $('hint')
  hint.textContent = text || ''
  hint.className = 'msg' + (tone ? ' ' + tone : '')
}

function setPairMsg(text, tone) {
  const msg = $('pair-msg')
  msg.textContent = text || ''
  msg.className = 'msg' + (tone ? ' ' + tone : '')
  msg.hidden = !text
}

function render(state) {
  STATE = state || null
  if (!STATE) return

  const online = !!STATE.online
  const paired = online && !!STATE.paired && STATE.integration !== false
  const integration = STATE.enabled !== false && STATE.integration !== false

  const status = $('status')
  status.className = 'status ' + (online ? 'online' : 'offline')
  $('status-text').textContent = !online
    ? 'Uygulama kapalı'
    : !integration
      ? 'Entegrasyon kapalı'
      : paired
        ? `Bağlı · 127.0.0.1:${STATE.port}`
        : 'Eşleştirme gerekli'

  // Eşleştirme kodu alanı, uygulama kapalıyken de görünür: kullanıcı nereye
  // yazacağını görsün. Uygulama açılınca (3 sn'lik yenileme) etkinleşir.
  show($('pair-panel'), !paired && integration)
  show($('main-panel'), online && paired)
  show($('pair-offline'), !paired && integration && !online)
  $('pair-code').disabled = !online
  $('pair-btn').disabled = !online

  const count = $('count')
  const n = Number(STATE.count) || 0
  count.textContent = n > 99 ? '99+' : String(n)
  show(count, paired && n > 0)

  $('srv-addr').textContent = online ? `127.0.0.1:${STATE.port}` : '—'
  $('opt-takeover').checked = STATE.takeOver !== false
  $('opt-detect').checked = STATE.autoDetect !== false
  $('opt-enabled').checked = integration

  if (!online) {
    setHint('IDMS uygulamasını başlatın; köprü 127.0.0.1:9789 üzerinde açılır.')
  } else if (!integration) {
    setHint('IDMS → Ayarlar → Tarayıcı bölümünden entegrasyonu açın.')
  } else if (!paired) {
    setHint('Eşleştirme kodu IDMS ayarlarında görünür.')
  } else if (STATE.lastError) {
    // Son yakalama hatası: tarayıcı indirmeleri devralınamadı.
    setHint(`Son hata: ${STATE.lastError}`, 'err')
  } else {
    setHint('IDMS hazır. Sağ tık menüsü ve yüzen panel etkin.')
  }

  renderDetected(paired)
}

function renderDetected(paired) {
  const list = (STATE && STATE.detected) || []
  show($('detected-sec'), true)
  show($('detected-empty'), list.length === 0)
  const ul = $('detected-list')
  ul.innerHTML = ''

  for (const item of list.slice(0, 30)) {
    const li = document.createElement('li')

    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = item.kind === 'stream' ? 'akış' : item.kind === 'media' ? 'medya' : 'dosya'

    const main = document.createElement('div')
    main.className = 'det-main'
    const name = document.createElement('div')
    name.className = 'det-name'
    name.textContent = item.name || item.url
    name.title = item.url
    const sub = document.createElement('div')
    sub.className = 'det-sub'
    sub.textContent = [item.mime, fmtBytes(item.size)].filter(Boolean).join(' · ') || item.url
    main.append(name, sub)

    const btn = document.createElement('button')
    btn.className = 'btn' + (paired ? ' primary' : '')
    btn.textContent = paired ? 'İndir' : 'Bağlan'
    btn.addEventListener('click', async () => {
      if (!paired) {
        // Eşleşmeden indirilemez: kullanıcıyı kod alanına götür.
        const panel = $('pair-panel')
        panel && panel.scrollIntoView({ block: 'start', behavior: 'smooth' })
        if (!STATE || !STATE.online) {
          setHint('Önce IDMS uygulamasını başlatın, sonra kodu girin.', 'err')
          return
        }
        const input = $('pair-code')
        input && input.focus()
        setHint('IDMS → Ayarlar → Tarayıcı bölümündeki 6 haneli kodu girin.', '')
        return
      }
      btn.disabled = true
      btn.textContent = '…'
      const res = await send({ type: 'download-detected', item })
      btn.textContent = res && res.ok ? '✓' : 'Hata'
      if (!res || !res.ok) setHint((res && res.error) || 'IDMS’e gönderilemedi', 'err')
      else setHint('IDMS kuyruğuna eklendi.', 'ok')
      setTimeout(() => {
        btn.disabled = false
        btn.textContent = 'İndir'
      }, 1600)
    })

    li.append(kind, main, btn)
    ul.appendChild(li)
  }
}

async function refresh() {
  const res = await send({ type: 'state' })
  if (res && res.ok && res.state) render(res.state)
  else setHint((res && res.error) || 'Durum alınamadı', 'err')
}

async function pairNow() {
  const input = $('pair-code')
  if (!STATE || !STATE.online) {
    setPairMsg('IDMS uygulaması kapalı. Uygulamayı başlatıp tekrar deneyin.', 'err')
    return
  }
  const code = (input.value || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    setPairMsg('6 haneli kodu girin (ör. ABC123).', 'err')
    input.focus()
    return
  }
  const btn = $('pair-btn')
  btn.disabled = true
  btn.textContent = 'Bağlanıyor…'
  setPairMsg('')
  const res = await send({ type: 'pair', code })
  btn.disabled = false
  btn.textContent = 'Eşleştir'
  if (res && res.ok && res.state) {
    setPairMsg('Eşleştirildi.', 'ok')
    input.value = ''
    render(res.state)
  } else {
    setPairMsg('Eşleştirme başarısız: ' + ((res && res.error) || 'bilinmeyen hata'), 'err')
  }
}

function bind() {
  $('pair-btn').addEventListener('click', () => void pairNow())
  $('pair-code').addEventListener('input', (ev) => {
    ev.target.value = String(ev.target.value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6)
  })
  $('pair-code').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void pairNow()
  })

  const save = async (patch) => {
    const res = await send({ type: 'config', patch })
    if (res && res.ok && res.state) render(res.state)
    else setHint((res && res.error) || 'Ayar kaydedilemedi', 'err')
  }

  $('opt-takeover').addEventListener('change', (ev) => void save({ takeOver: ev.target.checked }))
  $('opt-detect').addEventListener('change', (ev) => void save({ autoDetect: ev.target.checked }))
  $('opt-enabled').addEventListener('change', (ev) => void save({ enabled: ev.target.checked }))

  $('dl-page').addEventListener('click', async () => {
    const tabs = await api.tabs.query({ active: true, currentWindow: true })
    const tab = tabs && tabs[0]
    if (!tab || !/^https?:/i.test(tab.url || '')) {
      setHint('Bu sayfa indirilemiyor.', 'err')
      return
    }
    const res = await send({ type: 'download', url: tab.url, pageUrl: tab.url, name: tab.title || '', media: false })
    setHint(
      res && res.ok ? 'Sayfa IDMS kuyruğuna eklendi.' : (res && res.error) || 'IDMS’e gönderilemedi',
      res && res.ok ? 'ok' : 'err'
    )
  })

  $('open-app').addEventListener('click', async () => {
    const res = await send({ type: 'open-app' })
    if (!res || !res.ok) setHint((res && res.error) || 'IDMS penceresi açılamadı', 'err')
    else setHint('IDMS penceresi açıldı.', 'ok')
  })

  $('unpair').addEventListener('click', async () => {
    await send({ type: 'unpair' })
    setHint('Eşleştirme kaldırıldı.', 'ok')
    await refresh()
  })

  $('clear-detected').addEventListener('click', async () => {
    await send({ type: 'clear-detected', tabId: STATE ? STATE.tabId : null })
    await refresh()
  })

  $('refresh').addEventListener('click', () => void refresh())

  api.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === 'detected' || msg.type === 'status' || msg.type === 'error' || msg.type === 'unpaired')) {
      void refresh()
    }
    return false
  })
}

document.addEventListener('DOMContentLoaded', () => {
  bind()
  void refresh()
  clearInterval(refreshTimer)
  refreshTimer = setInterval(() => {
    if (!document.hidden) void refresh()
  }, 3000)
})

window.addEventListener('unload', () => clearInterval(refreshTimer))
