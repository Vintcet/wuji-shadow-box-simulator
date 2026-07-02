import { contextBridge, ipcRenderer } from 'electron'
import type { AppData, PriceRefreshProgress, PriceRefreshRequest, PriceRefreshResult, SimulationRequest, SimulationResult } from '../shared/types'

const api = {
  getData: (): Promise<AppData> => ipcRenderer.invoke('app:get-data'),
  refreshPrices: (request: PriceRefreshRequest): Promise<PriceRefreshResult> => ipcRenderer.invoke('app:refresh-prices', request),
  onPriceRefreshProgress: (callback: (progress: PriceRefreshProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: PriceRefreshProgress): void => callback(progress)
    ipcRenderer.on('app:refresh-prices-progress', listener)
    return () => ipcRenderer.off('app:refresh-prices-progress', listener)
  },
  simulate: (request: SimulationRequest): Promise<SimulationResult> => ipcRenderer.invoke('app:simulate', request)
}

contextBridge.exposeInMainWorld('wujiApi', api)

export type WujiApi = typeof api
