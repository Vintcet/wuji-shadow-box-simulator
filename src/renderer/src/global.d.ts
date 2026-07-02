import type { WujiApi } from '../../preload'

declare global {
  interface Window {
    wujiApi: WujiApi
  }
}

export {}
