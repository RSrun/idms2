/**
 * `parse-torrent` kendi tip tanımlarını yayınlamıyor; yalnızca bu projede
 * kullandığımız alanlar için minimal bir bildirim.
 */
declare module 'parse-torrent' {
  export interface ParsedTorrentFile {
    name: string
    path: string
    length: number
    offset?: number
  }

  export interface ParsedTorrent {
    name?: string
    length?: number
    files?: ParsedTorrentFile[]
    infoHash?: string
  }

  export default function parseTorrent(
    torrentId: string | Uint8Array | Buffer | object
  ): Promise<ParsedTorrent>
}
