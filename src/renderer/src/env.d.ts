/// <reference types="vite/client" />
import type { ExtendedApi } from '../../preload/index'
import type { DownloadWindowApi } from '@shared/types'

declare global {
  interface Window {
    idms2: ExtendedApi
    dlwin: DownloadWindowApi
  }
}

export {}
