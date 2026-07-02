import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AppData, PriceRefreshProgress, PriceRefreshRequest, PriceRefreshResult, SimulationRequest, SimulationResult } from '../../shared/types'

export const wujiApi = {
  getData: (): Promise<AppData> => invoke('get_data'),
  refreshPrices: (request: PriceRefreshRequest): Promise<PriceRefreshResult> => invoke('refresh_prices', { request }),
  simulate: (request: SimulationRequest): Promise<SimulationResult> => invoke('simulate', { request }),
  onPriceRefreshProgress: (callback: (progress: PriceRefreshProgress) => void): (() => void) => {
    let unlisten: UnlistenFn | null = null
    let disposed = false

    listen<PriceRefreshProgress>('app:refresh-prices-progress', (event) => {
      callback(event.payload)
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten()
      } else {
        unlisten = nextUnlisten
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }
}
