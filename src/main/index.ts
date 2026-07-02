import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron'
import type { WebContents } from 'electron'
import { dirname, join } from 'node:path'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import lootPools from './data/loot-pools.json'
import type {
  AppData,
  BoxOption,
  LootItem,
  PriceRefreshProgress,
  PriceRefreshRequest,
  PriceRefreshResult,
  PriceSnapshot,
  ServerGroup,
  SimulationRequest,
  SimulationResult
} from '../shared/types'

const SERVER_GROUPS: ServerGroup[] = [
  {
    zoneName: '电信区',
    servers: ['梦江南', '唯我独尊', '乾坤一掷', '斗转星移', '幽月轮', '剑胆琴心', '长安城', '蝶恋花', '龙争虎斗', '绝代天骄']
  },
  {
    zoneName: '双线区',
    servers: ['破阵子', '天鹅坪', '飞龙在天']
  },
  {
    zoneName: '无界区',
    servers: ['山海相逢', '眉间雪']
  }
]

interface RawLootItem {
  school: string
  shortName: string
  itemName: string
  itemId: string | null
  iconId: number | null
  jx3boxName: string | null
  missing?: boolean
}

interface RawBox {
  name: string
  itemId: string | null
  iconId?: number | null
  jx3boxName?: string | null
  missing?: boolean
  items: RawLootItem[]
}

interface RawLootPools {
  version: number
  enrichedAt?: string
  boxes: RawBox[]
}

interface LootDataset {
  sourcePath: string
  loadedAt: string
  boxes: BoxOption[]
  lootByBox: Map<string, LootItem[]>
  boxRefs: Map<string, PriceItemRef>
}

interface PriceItemRef {
  itemName: string
  itemId: string | null
  iconId: number | null
  jx3boxName: string | null
}

interface PriceLog {
  LowestPrice: number
  Date: string
  UpdatedAt?: string
  SampleSize?: number
}

interface AuctionPriceLog {
  price?: number
  timestamp?: number | string
}

interface PriceCacheFile {
  version: number
  updatedAt: string | null
  prices: Record<string, PriceSnapshot>
}

const staticLootPools = lootPools as RawLootPools
let cachedDataset: LootDataset | null = null
let cachedPriceFile: PriceCacheFile | null = null
const SALE_FEE_RATE = 0.05
const PRICE_REFRESH_CONCURRENCY = 16
const PRICE_REFRESH_COOLDOWN_MS = 5000
const PRICE_LOOKBACK_DAYS = 30
const PRICE_LOG_LIMIT = 60
const SIMULATION_MAX_COUNT = 999
let lastPriceRefreshStartedAt = 0

interface AppLogEntry {
  event: string
  details?: Record<string, unknown>
}

function getLogPath(): string {
  return join(dirname(process.execPath), 'log', `${localDateKey(new Date()) ?? 'unknown-date'}.log`)
}

async function writeAppLog(event: string, details: Record<string, unknown> = {}): Promise<void> {
  await writeAppLogEntries([{ event, details }])
}

async function writeAppLogEntries(entries: AppLogEntry[]): Promise<void> {
  if (entries.length === 0) {
    return
  }

  try {
    const logPath = getLogPath()
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(
      logPath,
      entries
        .map(({ event, details = {} }) =>
          JSON.stringify({
            time: new Date().toISOString(),
            event,
            ...details
          })
        )
        .join('\n') + '\n',
      'utf8'
    )
  } catch (error) {
    console.error('Failed to write app log:', error)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localDateKey(value: string | Date | null): string | null {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfLocalDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function parsePriceDate(value: string | null): Date | null {
  if (!value) {
    return null
  }

  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+08:00` : value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isWithinPriceLookback(value: string | null, now = new Date()): boolean {
  const date = parsePriceDate(value)
  if (!date) {
    return false
  }

  const earliest = startOfLocalDate(now)
  earliest.setDate(earliest.getDate() - (PRICE_LOOKBACK_DAYS - 1))
  return startOfLocalDate(date).getTime() >= earliest.getTime()
}

function wasPriceUpdatedToday(snapshot: PriceSnapshot | undefined, todayKey: string): boolean {
  return Boolean(snapshot?.lowestPrice !== null && localDateKey(snapshot?.fetchedAt ?? null) === todayKey)
}

function priceDateFromAuctionTimestamp(value: number | string | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }

  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return null
  }

  const date = new Date(numeric < 10000000000 ? numeric * 1000 : numeric)
  return localDateKey(date)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: '武技殊影图开图模拟器',
    backgroundColor: '#f6f4ee',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function loadLootDataset(): LootDataset {
  if (cachedDataset) {
    return cachedDataset
  }

  const lootByBox = new Map<string, LootItem[]>()
  const boxRefs = new Map<string, PriceItemRef>()

  for (const box of staticLootPools.boxes) {
    boxRefs.set(box.name, {
      itemName: box.name,
      itemId: box.itemId,
      iconId: box.iconId ?? null,
      jx3boxName: box.jx3boxName ?? null
    })

    lootByBox.set(
      box.name,
      box.items.map((item) => ({
        boxName: box.name,
        school: item.school,
        shortName: item.shortName,
        itemName: item.itemName,
        itemId: item.itemId,
        iconId: item.iconId,
        jx3boxName: item.jx3boxName,
        missing: item.missing
      }))
    )
  }

  cachedDataset = {
    sourcePath: 'src/main/data/loot-pools.json',
    loadedAt: staticLootPools.enrichedAt ?? new Date().toISOString(),
    boxes: staticLootPools.boxes.map((box) => ({
      name: box.name,
      itemCount: box.items.length,
      itemId: box.itemId,
      missing: box.missing
    })),
    lootByBox,
    boxRefs
  }

  return cachedDataset
}

function getPriceCachePath(): string {
  return join(app.getPath('userData'), 'price-cache.json')
}

async function loadPriceCache(): Promise<PriceCacheFile> {
  if (cachedPriceFile) {
    return cachedPriceFile
  }

  try {
    cachedPriceFile = JSON.parse(await readFile(getPriceCachePath(), 'utf8')) as PriceCacheFile
  } catch {
    cachedPriceFile = {
      version: 1,
      updatedAt: null,
      prices: {}
    }
  }

  return cachedPriceFile
}

async function savePriceCache(cache: PriceCacheFile): Promise<void> {
  const cachePath = getPriceCachePath()
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  cachedPriceFile = cache
}

async function getAppData(): Promise<AppData> {
  const dataset = loadLootDataset()
  const priceCache = await loadPriceCache()
  return {
    boxes: dataset.boxes,
    serverGroups: SERVER_GROUPS,
    sourcePath: dataset.sourcePath,
    loadedAt: dataset.loadedAt,
    priceCachePath: getPriceCachePath(),
    priceCacheUpdatedAt: priceCache.updatedAt
  }
}

function iconUrlFromIconId(iconId: number | null): string | null {
  return iconId ? `https://icon.jx3box.com/icon/${iconId}.png` : null
}

function cacheKey(server: string, ref: PriceItemRef): string {
  return `${server}::${ref.itemId ?? `name:${ref.itemName}`}`
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, '')
}

function snapshotWithoutPrice(ref: PriceItemRef, server: string, error: string, fetchedAt: string | null = null): PriceSnapshot {
  return {
    itemId: ref.itemId,
    itemName: ref.jx3boxName ?? ref.itemName,
    server,
    iconUrl: iconUrlFromIconId(ref.iconId),
    lowestPrice: null,
    date: null,
    updatedAt: null,
    fetchedAt,
    sampleSize: null,
    source: 'none',
    error
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'wuji-shadow-box-simulator/0.1.0'
    }
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return (await response.json()) as T
}

async function postJson<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json,text/plain,*/*',
      'content-type': 'application/json',
      'user-agent': 'wuji-shadow-box-simulator/0.1.0'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return (await response.json()) as T
}

function usablePriceLog(log: PriceLog | null | undefined, now = new Date()): PriceLog | null {
  if (!log || typeof log.LowestPrice !== 'number' || !log.Date || !isWithinPriceLookback(log.Date, now)) {
    return null
  }
  return log
}

async function queryPriceFromAuctionHistory(ref: PriceItemRef, server: string, fetchedAt: string): Promise<PriceSnapshot | null> {
  if (!ref.itemId) {
    return null
  }

  const payload = await postJson<AuctionPriceLog[] | { data?: AuctionPriceLog[] | null }>('https://next2.jx3box.com/api/auction/', {
    server,
    item_id: ref.itemId,
    aggregate_type: 'daily'
  })
  const rows = Array.isArray(payload) ? payload : payload.data ?? []
  const selected = rows
    .map((row) => ({
      ...row,
      date: priceDateFromAuctionTimestamp(row.timestamp)
    }))
    .filter((row) => typeof row.price === 'number' && row.date && isWithinPriceLookback(row.date))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0] ?? null

  if (!selected || !selected.date || typeof selected.price !== 'number') {
    return null
  }

  return {
    itemId: ref.itemId,
    itemName: ref.jx3boxName ?? ref.itemName,
    server,
    iconUrl: iconUrlFromIconId(ref.iconId),
    lowestPrice: selected.price,
    date: selected.date,
    updatedAt: null,
    fetchedAt,
    sampleSize: null,
    source: 'auction'
  }
}

async function queryPriceFromApi(ref: PriceItemRef, server: string): Promise<PriceSnapshot> {
  const fetchedAt = new Date().toISOString()

  if (!ref.itemId) {
    return snapshotWithoutPrice(ref, server, '静态表中没有 JX3BOX 物品 ID，无法更新价格', fetchedAt)
  }

  try {
    const url = `https://next2.jx3box.com/api/item-price/${encodeURIComponent(ref.itemId)}/logs?server=${encodeURIComponent(server)}&limit=${PRICE_LOG_LIMIT}`
    const payload = await fetchJson<{
      data?: {
        logs?: PriceLog[] | null
        today?: PriceLog | null
        yesterday?: PriceLog | null
      }
    }>(url)

    const now = new Date()
    const today = usablePriceLog(payload.data?.today, now)
    const yesterday = usablePriceLog(payload.data?.yesterday, now)
    const latest = (payload.data?.logs ?? [])
      .filter((log) => usablePriceLog(log, now))
      .sort((a, b) => b.Date.localeCompare(a.Date))[0] ?? null
    const selected = today ?? yesterday ?? latest

    if (selected) {
      return {
        itemId: ref.itemId,
        itemName: ref.jx3boxName ?? ref.itemName,
        server,
        iconUrl: iconUrlFromIconId(ref.iconId),
        lowestPrice: selected.LowestPrice,
        date: selected.Date,
        updatedAt: selected.UpdatedAt ?? null,
        fetchedAt,
        sampleSize: selected.SampleSize ?? null,
        source: today ? 'today' : yesterday ? 'yesterday' : 'history'
      }
    }

    const auctionSnapshot = await queryPriceFromAuctionHistory(ref, server, fetchedAt)
    if (auctionSnapshot) {
      return auctionSnapshot
    }

    return snapshotWithoutPrice(ref, server, `最近${PRICE_LOOKBACK_DAYS}天没有可用最低价数据`, fetchedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return snapshotWithoutPrice(ref, server, message, fetchedAt)
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  async function runNext(): Promise<void> {
    const index = cursor
    cursor += 1
    if (index >= items.length) {
      return
    }
    results[index] = await worker(items[index])
    await runNext()
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext))
  return results
}

function uniqueRefs(refs: PriceItemRef[]): PriceItemRef[] {
  const seen = new Set<string>()
  const result: PriceItemRef[] = []

  for (const ref of refs) {
    const key = ref.itemId ?? normalizeName(ref.itemName)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(ref)
    }
  }

  return result
}

function getRefsForBox(boxName: string): PriceItemRef[] {
  const dataset = loadLootDataset()
  const boxRef = dataset.boxRefs.get(boxName)
  const lootPool = dataset.lootByBox.get(boxName)

  if (!boxRef || !lootPool?.length) {
    throw new Error(`找不到箱子池子：${boxName}`)
  }

  return uniqueRefs([
    boxRef,
    ...lootPool.map((item) => ({
      itemName: item.itemName,
      itemId: item.itemId,
      iconId: item.iconId,
      jx3boxName: item.jx3boxName
    }))
  ])
}

function getAllServers(): string[] {
  return SERVER_GROUPS.flatMap((group) => group.servers)
}

function getRefsForAllBoxes(): PriceItemRef[] {
  const dataset = loadLootDataset()
  const refs: PriceItemRef[] = []

  for (const box of staticLootPools.boxes) {
    const boxRef = dataset.boxRefs.get(box.name)
    const lootPool = dataset.lootByBox.get(box.name)

    if (boxRef) {
      refs.push(boxRef)
    }

    refs.push(
      ...(lootPool ?? []).map((item) => ({
        itemName: item.itemName,
        itemId: item.itemId,
        iconId: item.iconId,
        jx3boxName: item.jx3boxName
      }))
    )
  }

  return uniqueRefs(refs)
}

function sendPriceRefreshProgress(sender: WebContents | null, progress: PriceRefreshProgress): void {
  sender?.send('app:refresh-prices-progress', progress)
}

async function refreshPrices(request: PriceRefreshRequest, sender: WebContents | null = null): Promise<PriceRefreshResult> {
  const requestId = request.requestId ?? `${Date.now()}`
  const now = Date.now()
  const cooldownRemaining = PRICE_REFRESH_COOLDOWN_MS - (now - lastPriceRefreshStartedAt)

  if (cooldownRemaining > 0) {
    await writeAppLog('price_refresh_blocked_cooldown', {
      requestId,
      scope: request.scope ?? 'selected',
      server: request.server,
      boxName: request.boxName,
      cooldownRemainingMs: cooldownRemaining
    })
    throw new Error(`更新价格太频繁，请 ${Math.ceil(cooldownRemaining / 1000)} 秒后再试。`)
  }

  lastPriceRefreshStartedAt = now
  const startedAt = now

  try {
    const refreshAll = request.scope === 'all'
    const refs = refreshAll ? getRefsForAllBoxes() : getRefsForBox(request.boxName)
    const servers = refreshAll ? getAllServers() : [request.server]
    const allTasks = servers.flatMap((serverName) => refs.map((ref) => ({ server: serverName, ref })))
    const cache = await loadPriceCache()
    const todayKey = localDateKey(new Date()) ?? ''
    const skippedTasks: Array<{ server: string; ref: PriceItemRef; snapshot: PriceSnapshot }> = []
    const tasks: Array<{ server: string; ref: PriceItemRef }> = []

    for (const task of allTasks) {
      const snapshot = cache.prices[cacheKey(task.server, task.ref)]
      if (wasPriceUpdatedToday(snapshot, todayKey)) {
        skippedTasks.push({ ...task, snapshot })
      } else {
        tasks.push(task)
      }
    }

    const total = tasks.length
    const skipped = skippedTasks.length
    let completed = 0
    let success = 0
    let failed = 0

    sendPriceRefreshProgress(sender, {
      requestId,
      completed,
      total,
      success,
      failed,
      skipped,
      server: null,
      itemName: null,
      done: total === 0
    })

    const results = await mapLimit(tasks, PRICE_REFRESH_CONCURRENCY, async (task) => {
      const snapshot = await queryPriceFromApi(task.ref, task.server)

      completed += 1
      if (snapshot.lowestPrice !== null) {
        success += 1
      } else {
        failed += 1
      }

      sendPriceRefreshProgress(sender, {
        requestId,
        completed,
        total,
        success,
        failed,
        skipped,
        server: task.server,
        itemName: task.ref.jx3boxName ?? task.ref.itemName,
        done: completed === total
      })

      return {
        server: task.server,
        ref: task.ref,
        snapshot
      }
    })
    const updatedAt = new Date().toISOString()

    for (const result of results) {
      cache.prices[cacheKey(result.server, result.ref)] = result.snapshot
    }

    if (results.length > 0) {
      cache.updatedAt = updatedAt
      await savePriceCache(cache)
    }

    const logEntries: AppLogEntry[] = [
      ...results.filter((result) => result.snapshot.lowestPrice === null).map((result) => ({
        event: 'price_refresh_item',
        details: {
          requestId,
          status: 'failed',
          server: result.server,
          itemId: result.ref.itemId,
          itemName: result.ref.jx3boxName ?? result.ref.itemName,
          lowestPrice: result.snapshot.lowestPrice,
          priceDate: result.snapshot.date,
          source: result.snapshot.source,
          fetchedAt: result.snapshot.fetchedAt,
          error: result.snapshot.error ?? 'unknown'
        }
      }))
    ]

    await writeAppLogEntries(logEntries)

    const response = {
      server: refreshAll ? '全部区服' : request.server,
      boxName: refreshAll ? '全部图' : request.boxName,
      updatedAt: cache.updatedAt ?? updatedAt,
      cachePath: getPriceCachePath(),
      total: results.length,
      success,
      failed,
      skipped,
      snapshots: results.map((result) => result.snapshot)
    }

    return response
  } catch (error) {
    await writeAppLog('price_refresh_failed', {
      requestId,
      scope: request.scope ?? 'selected',
      server: request.server,
      boxName: request.boxName,
      error: errorMessage(error),
      elapsedMs: Date.now() - startedAt
    })
    throw error
  }
}

async function getCachedPrice(ref: PriceItemRef, server: string): Promise<PriceSnapshot> {
  if (!ref.itemId) {
    return snapshotWithoutPrice(ref, server, '静态表中没有 JX3BOX 物品 ID')
  }

  const cache = await loadPriceCache()
  const snapshot = cache.prices[cacheKey(server, ref)]
  if (!snapshot) {
    return snapshotWithoutPrice(ref, server, '本地没有价格缓存，请先点击“更新价格数据”')
  }

  return snapshot
}

function drawLoot(items: LootItem[], count: number): LootItem[] {
  return Array.from({ length: count }, () => {
    const index = Math.floor(Math.random() * items.length)
    return items[index]
  })
}

function applySaleFee(price: number | null): number | null {
  return price === null ? null : Math.floor((price * 95) / 100)
}

async function simulate(request: SimulationRequest): Promise<SimulationResult> {
  const startedAt = Date.now()
  const count = Math.max(1, Math.min(SIMULATION_MAX_COUNT, Math.floor(Number(request.count) || 1)))

  try {
  const dataset = loadLootDataset()
  const lootPool = dataset.lootByBox.get(request.boxName)
  const boxRef = dataset.boxRefs.get(request.boxName)

  if (!lootPool?.length || !boxRef) {
    throw new Error(`找不到箱子池子：${request.boxName}`)
  }

  const refs = getRefsForBox(request.boxName)
  const snapshots = await Promise.all(refs.map((ref) => getCachedPrice(ref, request.server)))
  const snapshotByKey = new Map<string, PriceSnapshot>()

  for (let index = 0; index < refs.length; index += 1) {
    snapshotByKey.set(refs[index].itemId ?? normalizeName(refs[index].itemName), snapshots[index])
  }

  const boxPrice = snapshotByKey.get(boxRef.itemId ?? normalizeName(boxRef.itemName)) ?? snapshotWithoutPrice(boxRef, request.server, '本地没有价格缓存')

  const draws = drawLoot(lootPool, count).map((item, drawIndex) => {
    const price = snapshotByKey.get(item.itemId ?? normalizeName(item.itemName))
    return {
      index: drawIndex + 1,
      itemName: item.itemName,
      school: item.school,
      iconUrl: price?.iconUrl ?? iconUrlFromIconId(item.iconId),
      price: price?.lowestPrice ?? null,
      netPrice: applySaleFee(price?.lowestPrice ?? null),
      date: price?.date ?? null
    }
  })

  const aggregate = new Map<string, {
    itemName: string
    school: string
    iconUrl: string | null
    count: number
    unitPrice: number | null
    unitNetPrice: number | null
    date: string | null
  }>()

  for (const draw of draws) {
    const key = normalizeName(draw.itemName)
    const existing = aggregate.get(key)
    if (existing) {
      existing.count += 1
    } else {
      aggregate.set(key, {
        itemName: draw.itemName,
        school: draw.school,
        iconUrl: draw.iconUrl,
        count: 1,
        unitPrice: draw.price,
        unitNetPrice: draw.netPrice,
        date: draw.date
      })
    }
  }

  const items = [...aggregate.values()]
    .map((item) => ({
      ...item,
      subtotal: item.unitNetPrice === null ? null : item.unitNetPrice * item.count
    }))
    .sort((a, b) => (b.subtotal ?? 0) - (a.subtotal ?? 0))

  const grossValue = draws.reduce((sum, item) => sum + (item.price ?? 0), 0)
  const totalValue = draws.reduce((sum, item) => sum + (item.netPrice ?? 0), 0)
  const saleFee = grossValue - totalValue
  const boxUnitCost = boxPrice.lowestPrice
  const totalCost = boxUnitCost === null ? null : boxUnitCost * count
  const profit = totalCost === null ? null : totalValue - totalCost
  const roi = profit === null || totalCost === null || totalCost === 0 ? null : profit / totalCost
  const missingItems = items.filter((item) => item.unitPrice === null).map((item) => item.itemName)
  const dataDates = [...new Set([boxPrice.date, ...items.map((item) => item.date)].filter(Boolean) as string[])].sort()

  const response: SimulationResult = {
    boxName: request.boxName,
    server: request.server,
    count,
    dataDates,
    priceBasis: 'lowest',
    boxPrice,
    boxUnitCost,
    totalCost,
    grossValue,
    saleFee,
    saleFeeRate: SALE_FEE_RATE,
    totalValue,
    profit,
    roi,
    missingPriceCount: missingItems.length,
    missingItems,
    items,
    draws
  }

  return response
  } catch (error) {
    await writeAppLog('simulation_failed', {
      server: request.server,
      boxName: request.boxName,
      count,
      error: errorMessage(error),
      elapsedMs: Date.now() - startedAt
    })
    throw error
  }
}

ipcMain.handle('app:get-data', () => getAppData())
ipcMain.handle('app:refresh-prices', async (event, request: PriceRefreshRequest) => refreshPrices(request, event.sender))
ipcMain.handle('app:simulate', async (_event, request: SimulationRequest) => simulate(request))

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
