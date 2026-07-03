import { useEffect, useState } from 'react'
import { AlertTriangle, BarChart3, Box, Coins, Database, History, Play, RefreshCw, Server, Sparkles, Trash2 } from 'lucide-react'
import type { AppData, BoxOption, MissingPriceMode, PriceRefreshProgress, PriceRefreshResult, SimulationResult } from '../../shared/types'
import { wujiApi } from './api'
import brickIcon from './assets/trade/brick.png'
import goldIcon from './assets/trade/gold.png'

const DEFAULT_COUNT = 10
const MAX_OPEN_COUNT = 999
const HISTORY_STORAGE_KEY = 'wuji-opening-history'
const MAX_HISTORY_RECORDS = 20
const COPPER_PER_GOLD = 10000
const COPPER_PER_BRICK = 100000000
const APP_VERSION = 'v0.1.0'
const APP_RELEASE_DATE = '2026-07-03'
const APP_AUTHOR = '兰舟少住'

interface OpeningHistoryRecord {
  id: string
  createdAt: string
  server: string
  boxName: string
  count: number
  totalCost: number | null
  totalValue: number
  profit: number | null
  roi: number | null
  missingPriceCount: number
}

interface MoneyPart {
  value: number
  icon: string
}

function moneyParts(value: number): MoneyPart[] {
  const absolute = Math.abs(value)
  const brick = Math.floor(absolute / COPPER_PER_BRICK)
  const gold = Math.floor((absolute % COPPER_PER_BRICK) / COPPER_PER_GOLD)

  if (brick > 0) {
    return [
      { value: brick, icon: brickIcon },
      ...(gold > 0 ? [{ value: gold, icon: goldIcon }] : [])
    ]
  }

  return [{ value: gold, icon: goldIcon }]
}

function Money({ value, className = '' }: { value: number | null; className?: string }) {
  if (value === null || Number.isNaN(value)) {
    return <span className={`money missing ${className}`}>无数据</span>
  }

  return (
    <span className={`money ${className}`}>
      {value < 0 && <span className="money-sign">-</span>}
      {moneyParts(value).map((part, index) => (
        <span className="money-part" key={`${part.icon}-${index}`}>
          <span>{part.value}</span>
          <img src={part.icon} alt="" />
        </span>
      ))}
    </span>
  )
}

function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '无数据'
  }
  return `${(value * 100).toFixed(2)}%`
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return '未更新'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function dataDateLabel(dates: string[]): string {
  if (dates.length === 0) {
    return '待查询'
  }
  if (dates.length === 1) {
    return dates[0]
  }
  return `${dates[0]} 至 ${dates[dates.length - 1]}`
}

function dataDatesFromRefreshResult(result: PriceRefreshResult): string[] {
  return [...new Set(result.snapshots.map((snapshot) => snapshot.date).filter(Boolean) as string[])].sort()
}

function optionLabel(box: BoxOption): string {
  return box.name
}

function outcomeClass(value: number | null): string {
  if (value === null) {
    return ''
  }
  return value >= 0 ? 'positive' : 'negative'
}

function readHistoryRecords(): OpeningHistoryRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as OpeningHistoryRecord[]).slice(0, MAX_HISTORY_RECORDS) : []
  } catch {
    return []
  }
}

function saveHistoryRecords(records: OpeningHistoryRecord[]): void {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(records))
}

function historyRecordFromResult(result: SimulationResult): OpeningHistoryRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    server: result.server,
    boxName: result.boxName,
    count: result.count,
    totalCost: result.totalCost,
    totalValue: result.totalValue,
    profit: result.profit,
    roi: result.roi,
    missingPriceCount: result.missingPriceCount
  }
}

export default function App() {
  const [appData, setAppData] = useState<AppData | null>(null)
  const [server, setServer] = useState('')
  const [boxName, setBoxName] = useState('')
  const [count, setCount] = useState(DEFAULT_COUNT)
  const [missingPriceMode, setMissingPriceMode] = useState<MissingPriceMode>('zero')
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [refreshResult, setRefreshResult] = useState<PriceRefreshResult | null>(null)
  const [refreshProgress, setRefreshProgress] = useState<PriceRefreshProgress | null>(null)
  const [showRefreshStatus, setShowRefreshStatus] = useState(false)
  const [historyRecords, setHistoryRecords] = useState<OpeningHistoryRecord[]>(readHistoryRecords)
  const [priceDataDates, setPriceDataDates] = useState<string[]>([])
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    wujiApi
      .getData()
      .then((data) => {
        setAppData(data)
        setCacheUpdatedAt(data.priceCacheUpdatedAt)
        setServer(data.serverGroups[0]?.servers[0] ?? '')
        setBoxName(data.boxes[0]?.name ?? '')
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }, [])

  const priceStatus = refreshing
    ? refreshProgress
      ? `更新中：${refreshProgress.completed}/${refreshProgress.total}，成功 ${refreshProgress.success}，失败 ${refreshProgress.failed}，跳过 ${refreshProgress.skipped}`
      : '更新中...'
    : refreshResult
      ? `更新完成：成功 ${refreshResult.success}，失败 ${refreshResult.failed}，跳过 ${refreshResult.skipped}`
      : ''

  useEffect(() => {
    return wujiApi.onPriceRefreshProgress((progress) => {
      setRefreshProgress(progress)
    })
  }, [])

  useEffect(() => {
    if (refreshing) {
      setShowRefreshStatus(true)
      return
    }

    if (!refreshResult) {
      return
    }

    setShowRefreshStatus(true)
    const fadeTimer = window.setTimeout(() => setShowRefreshStatus(false), 3500)
    const clearTimer = window.setTimeout(() => {
      setRefreshResult(null)
      setRefreshProgress(null)
    }, 4300)

    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(clearTimer)
    }
  }, [refreshResult, refreshing])

  async function refreshPrices(): Promise<void> {
    if (!appData) {
      setError('数据还没有载入。')
      return
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setRefreshing(true)
    setShowRefreshStatus(true)
    setRefreshProgress(null)
    setError('')
    try {
      const nextRefreshResult = await wujiApi.refreshPrices({
        server,
        boxName,
        scope: 'all',
        requestId
      })
      const nextAppData = await wujiApi.getData()
      setRefreshResult(nextRefreshResult)
      setAppData(nextAppData)
      setCacheUpdatedAt(nextAppData.priceCacheUpdatedAt ?? nextRefreshResult.updatedAt)
      const nextDataDates = dataDatesFromRefreshResult(nextRefreshResult)
      if (nextDataDates.length > 0) {
        setPriceDataDates(nextDataDates)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRefreshing(false)
    }
  }

  async function runSimulation(): Promise<void> {
    if (!server || !boxName) {
      setError('请先选择区服和图的种类。')
      return
    }

    setLoading(true)
    setError('')
    try {
      const nextResult = await wujiApi.simulate({
        server,
        boxName,
        count,
        missingPriceMode
      })
      setResult(nextResult)
      setPriceDataDates(nextResult.dataDates)
      setHistoryRecords((records) => {
        const nextRecords = [historyRecordFromResult(nextResult), ...records].slice(0, MAX_HISTORY_RECORDS)
        saveHistoryRecords(nextRecords)
        return nextRecords
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  function clearHistory(): void {
    setHistoryRecords([])
    localStorage.removeItem(HISTORY_STORAGE_KEY)
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={24} />
          </div>
          <div>
            <h1>武技殊影图</h1>
            <p>开图模拟器</p>
          </div>
        </div>

        <section className="control-panel" aria-label="模拟参数">
          <label>
            <span>
              <Server size={16} />
              区服
            </span>
            <select value={server} onChange={(event) => setServer(event.target.value)} disabled={!appData || loading}>
              {appData?.serverGroups.map((group) => (
                <optgroup key={group.zoneName} label={group.zoneName}>
                  {group.servers.map((serverName) => (
                    <option key={serverName} value={serverName}>
                      {serverName}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label>
            <span>
              <Box size={16} />
              图的种类
            </span>
            <select value={boxName} onChange={(event) => setBoxName(event.target.value)} disabled={!appData || loading}>
              {appData?.boxes.map((box) => (
                <option key={box.name} value={box.name}>
                  {optionLabel(box)}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>
              <BarChart3 size={16} />
              数量
            </span>
            <input
              type="number"
              min={1}
              max={MAX_OPEN_COUNT}
              step={1}
              value={count}
              onChange={(event) => setCount(Math.max(1, Math.min(MAX_OPEN_COUNT, Number(event.target.value) || 1)))}
              disabled={loading}
            />
          </label>

          <button className="secondary-button" type="button" onClick={refreshPrices} disabled={!appData || refreshing || loading}>
            <RefreshCw size={18} className={refreshing ? 'spin' : ''} />
            {refreshing ? '正在更新全部价格' : '更新全部价格'}
          </button>
          {priceStatus && <div className={`price-status ${refreshing ? 'active' : 'done'} ${showRefreshStatus ? 'show' : 'hide'}`}>{priceStatus}</div>}

          <button className="primary-button" type="button" onClick={runSimulation} disabled={!appData || loading || refreshing}>
            <Play size={18} />
            {loading ? '开图中' : '开始开图'}
          </button>
        </section>

        <section className="source-panel" aria-label="数据来源">
          <div>
            <Database size={16} />
            <span>价格口径</span>
            <strong>最新最低价</strong>
          </div>
          <label>
            <Coins size={16} />
            <span>缺价处理</span>
            <select value={missingPriceMode} onChange={(event) => setMissingPriceMode(event.target.value as MissingPriceMode)} disabled={loading}>
              <option value="zero">视为0</option>
              <option value="box-cost">视为成本价</option>
            </select>
          </label>
          <div>
            <Coins size={16} />
            <span>数据日期</span>
            <strong>{dataDateLabel(priceDataDates.length > 0 ? priceDataDates : result?.dataDates ?? [])}</strong>
          </div>
          <div>
            <RefreshCw size={16} />
            <span>缓存更新</span>
            <strong>{formatDateTime(cacheUpdatedAt)}</strong>
          </div>
        </section>
      </aside>

      <section className="workspace">
        {error && (
          <div className="notice" role="alert">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        )}

        {!result ? (
          <section className="empty-state">
            <div className="empty-icon">
              <Sparkles size={40} />
            </div>
            <h2>选择区服、图的种类和数量后开始模拟</h2>
            <p>先点击更新价格数据写入本地缓存，再按缓存里的 JX3BOX 最新可用最低价计算开图结果。</p>
          </section>
        ) : (
          <>
            <section className="summary-grid" aria-label="收益计算">
              <div className="metric">
                <span>武技图单价</span>
                <strong>
                  <Money value={result.boxUnitCost} />
                </strong>
              </div>
              <div className="metric">
                <span>总成本</span>
                <strong>
                  <Money value={result.totalCost} />
                </strong>
              </div>
              <div className="metric">
                <span>产出价值</span>
                <strong>
                  <Money value={result.totalValue} />
                </strong>
              </div>
              <div className={`metric ${result.profit !== null && result.profit >= 0 ? 'positive' : 'negative'}`}>
                <span>净收益</span>
                <strong>
                  <Money value={result.profit} />
                </strong>
              </div>
              <div className="metric roi-metric">
                <span>收益率</span>
                <strong>{formatPercent(result.roi)}</strong>
              </div>
            </section>

            <section className="result-header">
              <div>
                <h2>
                  {result.server} · {result.boxName}
                </h2>
              </div>
            </section>

            <section className="table-section" aria-label="逐次开图明细">
              <div className="section-title">
                <h3>开图明细</h3>
                <span>显示全部 {result.draws.length} 次</span>
              </div>
              <div className="draw-list">
                {result.draws.map((draw) => (
                  <div className="draw-row" key={`${draw.index}-${draw.itemName}`}>
                    <span className="draw-index">#{draw.index}</span>
                    <span className="item-name">
                      {draw.iconUrl ? <img src={draw.iconUrl} alt="" /> : <span className="icon-fallback" />}
                      {draw.itemName}
                    </span>
                    <span>{draw.school}</span>
                    <span className="price-stack">
                      <strong>
                        {draw.priceLabel && <span className="price-label">（{draw.priceLabel}）</span>}
                        <Money value={draw.netPrice} />
                      </strong>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </section>

      <aside className="history-sidebar">
        <section className="history-panel" aria-label="历史开图记录">
          <div className="panel-title">
            <span>
              <History size={16} />
              历史开图记录
            </span>
            {historyRecords.length > 0 && (
              <button className="icon-button" type="button" onClick={clearHistory} aria-label="清空历史开图记录">
                <Trash2 size={14} />
                清空
              </button>
            )}
          </div>

          {historyRecords.length === 0 ? (
            <p className="history-empty">暂无记录</p>
          ) : (
            <div className="history-list">
              {historyRecords.map((record) => (
                <article className={`history-record ${outcomeClass(record.profit)}`} key={record.id}>
                  <div className="history-main">
                    <strong>{record.boxName}</strong>
                    <span>
                      {record.server} · {record.count} 次
                    </span>
                  </div>
                  <div className="history-line">
                    <span>{formatDateTime(record.createdAt)}</span>
                    <strong>
                      <Money value={record.profit} />
                    </strong>
                  </div>
                  <div className="history-line">
                    <span>
                      成本 <Money value={record.totalCost} />
                    </span>
                    <span>
                      产出 <Money value={record.totalValue} />
                    </span>
                  </div>
                  {record.missingPriceCount > 0 && <div className="history-warning">{record.missingPriceCount} 个结果缺少价格</div>}
                </article>
              ))}
            </div>
          )}
        </section>
        <section className="app-meta" aria-label="版本信息">
          <div>
            <span>版本</span>
            <strong>{APP_VERSION}</strong>
          </div>
          <div>
            <span>日期</span>
            <strong>{APP_RELEASE_DATE}</strong>
          </div>
          <div>
            <span>作者</span>
            <strong>{APP_AUTHOR}</strong>
          </div>
        </section>
      </aside>
    </main>
  )
}
