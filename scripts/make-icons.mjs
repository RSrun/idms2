/**
 * IDMS2 ikonlarını üretir (saf PNG, harici bağımlılık yok).
 *   node scripts/make-icons.mjs
 *
 * Tasarım: mavi-mor degrade kare içinde beyaz indirme oku.
 * Hem uygulama (resources/icon.png) hem eklenti (extension klasörleri) için.
 */
import { deflateSync } from 'zlib'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

/* ---------------- CRC32 ---------------- */
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/** RGBA buffer'dan PNG üret */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Satır başına filtre baytı (0) + piksel verisi
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  const idat = deflateSync(raw, { level: 9 })

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/* ---------------- Çizim ---------------- */

function lerp(a, b, t) {
  return a + (b - a) * t
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const r0 = 0.255 * 255,
    g0 = 0.435 * 255,
    b0 = 0.933 * 255 // #416fee
  const r1 = 0.482 * 255,
    g1 = 0.361 * 255,
    b1 = 0.941 * 255 // #7b5cf0

  const radius = size * 0.23
  const cx = size / 2
  const cy = size / 2

  // Ok geometrisi (birim koordinatlar, size ile ölçeklenir)
  // Gövde: dikey dikdörtgen + aşağı üçgen uç
  const stemHalf = 0.11
  const stemTop = 0.2
  const stemBottom = 0.56
  const headHalf = 0.3
  const headTop = 0.52
  const headBottom = 0.82
  const barHalf = 0.32
  const barTop = 0.84
  const barBottom = 0.95

  const insideRounded = (x, y) => {
    // Yuvarlatılmış köşeli kare
    const dx = Math.abs(x - cx)
    const dy = Math.abs(y - cy)
    const hw = size / 2
    if (dx > hw - radius || dy > hw - radius) {
      const ox = Math.max(dx - (hw - radius), 0)
      const oy = Math.max(dy - (hw - radius), 0)
      return ox * ox + oy * oy <= radius * radius
    }
    return true
  }

  // Antialiasing için 2x2 alt örnekleme (küçük boyutlarda kenar temizliği)
  const ss = size >= 24 ? 3 : 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let aAcc = 0
      let arrowAcc = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss
          const py = y + (sy + 0.5) / ss
          if (insideRounded(px, py)) aAcc++

          // Birim kare koordinat (-0.5..0.5)
          const ux = (px - cx) / size
          const uy = (py - cy) / size
          if (insideRounded(px, py) && isArrow(ux, uy, { stemHalf, stemTop, stemBottom, headHalf, headTop, headBottom, barHalf, barTop, barBottom })) {
            arrowAcc++
          }
        }
      }
      const alpha = aAcc / (ss * ss)
      const arrow = arrowAcc / (ss * ss)

      const i = (y * size + x) * 4
      if (alpha <= 0) continue

      const tt = (x + y) / (2 * size)
      let r = lerp(r0, r1, tt)
      let g = lerp(g0, g1, tt)
      let b = lerp(b0, b1, tt)

      if (arrow > 0) {
        // Beyaz ok, kenar yumuşatma ile karıştır
        const a = Math.min(1, arrow)
        r = lerp(r, 255, a)
        g = lerp(g, 255, a)
        b = lerp(b, 255, a)
      }

      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, size, rgba)
}

/** Birim karede ok biçiminde mi? (uy: aşağı pozitif, merkez 0) */
function isArrow(ux, uy, g) {
  const px = Math.abs(ux)

  // Gövde (dikey dikdörtgen): fraksiyonlar üstten (0) aşağı (1) → merkez bazlı
  const stemA = g.stemTop - 0.5
  const stemB = g.stemBottom - 0.5
  if (px <= g.stemHalf && uy >= stemA && uy <= stemB) return true

  // Baş (aşağı yönlü üçgen): genişlik tepeden uca doğru daralır
  const headA = g.headTop - 0.5
  const headB = g.headBottom - 0.5
  if (uy >= headA && uy <= headB) {
    const t = (uy - headA) / (headB - headA)
    const halfW = lerp(g.headHalf, 0, t)
    if (px <= halfW) return true
  }

  // Taban çubuğu (okun altında çizgi)
  const barA = g.barTop - 0.5
  const barB = g.barBottom - 0.5
  if (px <= g.barHalf && uy >= barA && uy <= barB) return true

  return false
}

/* ---------------- Yaz ---------------- */

const targets = [
  join(root, 'resources', 'icon.png'),
  join(root, 'extension', 'chromium', 'icons', 'icon16.png'),
  join(root, 'extension', 'chromium', 'icons', 'icon32.png'),
  join(root, 'extension', 'chromium', 'icons', 'icon48.png'),
  join(root, 'extension', 'chromium', 'icons', 'icon128.png'),
  join(root, 'extension', 'gecko', 'icons', 'icon16.png'),
  join(root, 'extension', 'gecko', 'icons', 'icon32.png'),
  join(root, 'extension', 'gecko', 'icons', 'icon48.png'),
  join(root, 'extension', 'gecko', 'icons', 'icon128.png')
]

for (const p of targets) {
  mkdirSync(dirname(p), { recursive: true })
  const m = /icon(\d+)\.png$/.exec(p)
  const size = m ? parseInt(m[1], 10) : 256
  writeFileSync(p, drawIcon(size))
  console.log('✓', p.replace(root + '\\', ''), `(${size}x${size})`)
}
