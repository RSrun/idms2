/**
 * Bağımlılıksız ZIP yazıcısı (Firefox/Zen `.xpi` paketi için).
 *
 * Yalnızca ihtiyaç duyduğumuz alt küme: tek disk, deflate sıkıştırma,
 * klasör girdisi yok (dosya yolları `/` ile yazılır). Harici `zip`/`tar`
 * aracına ve yerel modüle ihtiyaç duymamak için doğrudan ZIP yapısı üretilir.
 */

import { deflateRawSync } from 'zlib'
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'

/** CRC32 tablosu (IEEE 802.3) */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS tarih/saat (yerel saat, 2 sn çözünürlük) */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2) & 0x1f) << 0)
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f)
  return { time: time & 0xffff, date: day & 0xffff }
}

function collectFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectFiles(full, base))
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out
}

/**
 * `srcDir` içeriğini `outFile` konumuna ZIP olarak yazar.
 * Girdi dosyaları arşiv kökünde yer alır (manifest.json en üstte olmalı).
 */
export function writeZip(srcDir: string, outFile: string): void {
  const files = collectFiles(srcDir).sort()
  if (files.length === 0) throw new Error(`ZIP kaynağı boş: ${srcDir}`)

  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const { time, date } = dosDateTime(new Date())

  for (const rel of files) {
    const abs = join(srcDir, rel)
    const name = rel.split(sep).join('/')
    const nameBuf = Buffer.from(name, 'utf8')
    const data = readFileSync(abs)
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // sürüm
    local.writeUInt16LE(0x0800, 6) // UTF-8 dosya adı
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, compressed)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // yapan sürüm
    cd.writeUInt16LE(20, 6) // gereken sürüm
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // iç öznitelik
    cd.writeUInt32LE(0, 38) // dış öznitelik
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + compressed.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, eocd]))
}

/** ZIP dosyasının `PK\x03\x04` imzasıyla başladığını doğrular. */
export function isZipFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    const head = Buffer.alloc(4)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, head, 0, 4, 0)
    } finally {
      closeSync(fd)
    }
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  } catch {
    return false
  }
}
