/**
 * webtorrent için tip deklarasyonu (paket kendi tiplerini dağıtmıyor).
 * Kullandığımız alt kümi tanımlanır; geri kalanı any kalır.
 */

declare module 'webtorrent' {
  import { EventEmitter } from 'events'

  interface WebTorrentFile {
    name: string
    path: string
    length: number
    progress: number
    download(): void
    getBlob(cb: (err: Error | null, blob: Blob) => void): void
    streamToWritable(w: NodeJS.WritableStream): void
  }

  interface WebTorrentTorrent extends EventEmitter {
    infoHash: string
    name: string
    files: WebTorrentFile[]
    length: number
    progress: number
    downloadSpeed: number
    uploadSpeed: number
    ratio: number
    numPeers: number
    timeRemaining: number
    done: boolean
    paused: boolean
    metadata: boolean
    ready: boolean
    pause(): void
    resume(): void
    deselect(start: number, end: number, priority?: boolean): void
    select(start: number, end: number, priority?: boolean): void
    destroy(
      opts?: { destroyStore?: boolean },
      cb?: (err?: Error) => void
    ): void
    on(event: 'download' | 'upload' | 'done' | 'metadata' | 'ready' | 'wire', cb: (...args: any[]) => void): this
    on(event: 'error', cb: (err: Error) => void): this
    once(event: 'ready' | 'metadata', cb: () => void): this
  }

  interface WebTorrentOptions {
    dht?: boolean | object
    utp?: boolean
    lsd?: boolean
    natUpnp?: boolean
    natPmp?: boolean
    torrentPort?: number
    dhtPort?: number
    tracker?: boolean | object
    webSeeds?: boolean
    connect?: boolean
    maxConns?: number
  }

  class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions)
    torrents: WebTorrentTorrent[]
    downloadSpeed: number
    uploadSpeed: number
    progress: number

    add(
      torrentId: string | Buffer | ArrayBuffer | File,
      opts?: { path?: string },
      cb?: (torrent: WebTorrentTorrent) => void
    ): WebTorrentTorrent
    remove(
      torrentId: string | WebTorrentTorrent,
      cb?: (err?: Error) => void
    ): void
    get(torrentId: string): WebTorrentTorrent | undefined
    destroy(cb?: () => void): void

    on(event: 'error', cb: (err: Error) => void): this
    on(event: 'torrent', cb: (torrent: WebTorrentTorrent) => void): this
    on(event: string, cb: (...args: any[]) => void): this
  }

  export = WebTorrent
}
