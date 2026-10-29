import type { CategoryId } from '@shared/types'

/** Windows/Unix karışık yollar için son klasörü döndürür. */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

/** Yolun dosya adı kısmı. */
export function baseOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** Klasör + dosya adı (ayırıcıyı klasörden seçer). */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

const EXT_CATEGORY: Record<string, CategoryId> = {
  mp4: 'video',
  mkv: 'video',
  avi: 'video',
  webm: 'video',
  mov: 'video',
  flv: 'video',
  wmv: 'video',
  m4v: 'video',
  mpg: 'video',
  mpeg: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  wma: 'audio',
  opus: 'audio',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  iso: 'archive',
  exe: 'program',
  msi: 'program',
  apk: 'program',
  deb: 'program',
  rpm: 'program',
  dmg: 'program',
  app: 'program',
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  txt: 'document',
  epub: 'document'
}

export function categoryForName(name: string): CategoryId {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return EXT_CATEGORY[ext] || 'other'
}

/** URL'den dosya adı (sorgu dizesi olmadan). */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    if (last && last.includes('.')) return last
    if (last) return last
  } catch {
    /* geçersiz URL */
  }
  return 'download'
}

/** Uzantıya göre kısa etiket ve renk sınıfı. */
export function fileBadge(name: string): { text: string; kind: string } {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    zip: 'ZIP',
    rar: 'RAR',
    '7z': '7Z',
    iso: 'ISO',
    exe: 'EXE',
    msi: 'MSI',
    apk: 'APK',
    pdf: 'PDF',
    mp4: 'MP4',
    mkv: 'MKV',
    avi: 'AVI',
    mp3: 'MP3',
    m4a: 'M4A',
    doc: 'DOC',
    docx: 'DOC',
    xls: 'XLS',
    xlsx: 'XLS',
    txt: 'TXT'
  }
  const category = categoryForName(name)
  return {
    text: map[ext] || (ext ? ext.slice(0, 4).toUpperCase() : 'FILE'),
    kind: category
  }
}

/** Bağlantı çubuğundaki segment rengi. */
export function segmentTone(seg: { received: number; size: number; done: boolean }): string {
  if (seg.done) return 'done'
  if (seg.received > 0) return 'active'
  return 'idle'
}
