export type PriceSource = 'today' | 'yesterday' | 'latest' | 'history' | 'auction' | 'none'
export type MissingPriceMode = 'zero' | 'box-cost'

export interface LootItem {
  boxName: string
  school: string
  shortName: string
  itemName: string
  itemId: string | null
  iconId: number | null
  jx3boxName: string | null
  missing?: boolean
}

export interface BoxOption {
  name: string
  itemCount: number
  itemId: string | null
  missing?: boolean
}

export interface ServerGroup {
  zoneName: string
  servers: string[]
}

export interface AppData {
  boxes: BoxOption[]
  serverGroups: ServerGroup[]
  sourcePath: string
  loadedAt: string
  priceCachePath: string
  priceCacheUpdatedAt: string | null
}

export interface PriceSnapshot {
  itemId: string | null
  itemName: string
  server: string
  iconUrl: string | null
  lowestPrice: number | null
  date: string | null
  updatedAt: string | null
  fetchedAt: string | null
  sampleSize: number | null
  source: PriceSource
  error?: string
}

export interface SimulationRequest {
  server: string
  boxName: string
  count: number
  missingPriceMode: MissingPriceMode
}

export interface PriceRefreshRequest {
  server: string
  boxName: string
  scope?: 'selected' | 'all'
  requestId?: string
}

export interface PriceRefreshResult {
  server: string
  boxName: string
  updatedAt: string
  cachePath: string
  total: number
  success: number
  failed: number
  skipped: number
  snapshots: PriceSnapshot[]
}

export interface PriceRefreshProgress {
  requestId: string
  completed: number
  total: number
  success: number
  failed: number
  skipped: number
  server: string | null
  itemName: string | null
  done: boolean
}

export interface DrawResult {
  index: number
  itemName: string
  school: string
  iconUrl: string | null
  price: number | null
  netPrice: number | null
  priceLabel?: string | null
  missingPrice?: boolean
  date: string | null
}

export interface AggregatedResult {
  itemName: string
  school: string
  iconUrl: string | null
  count: number
  unitPrice: number | null
  unitNetPrice: number | null
  subtotal: number | null
  date: string | null
}

export interface SimulationResult {
  boxName: string
  server: string
  count: number
  dataDates: string[]
  priceBasis: 'lowest'
  boxPrice: PriceSnapshot
  boxUnitCost: number | null
  totalCost: number | null
  grossValue: number
  saleFee: number
  saleFeeRate: number
  totalValue: number
  profit: number | null
  roi: number | null
  missingPriceCount: number
  missingItems: string[]
  items: AggregatedResult[]
  draws: DrawResult[]
}
