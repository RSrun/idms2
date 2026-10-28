/// <reference types="vite/client" />
import type { ExtendedApi } from '../../preload/index'

declare global {
  interface Window {
    idms2: ExtendedApi
  }
}

export {}
