import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const dataPath = new URL('../src/data/loot-pools.json', import.meta.url)

function normalizeName(name) {
  return String(name).replace(/\s+/g, '')
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'wuji-shadow-box-simulator-data/0.1.0'
    }
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json()
}

async function searchItem(itemName) {
  const payload = await fetchJson(
    `https://node.jx3box.com/api/node/item/search?ids=&keyword=${encodeURIComponent(itemName)}&client=std&per=35`
  )
  const items = payload?.data?.data ?? []
  const wanted = normalizeName(itemName)
  const item =
    items.find((candidate) => candidate.Name === itemName) ??
    items.find((candidate) => normalizeName(candidate.Name) === wanted) ??
    items.find((candidate) => normalizeName(candidate.Name).includes(wanted)) ??
    null

  if (!item) {
    return {
      itemId: null,
      iconId: null,
      jx3boxName: null,
      missing: true
    }
  }

  return {
    itemId: item.id,
    iconId: item.IconID ?? null,
    jx3boxName: item.Name,
    missing: false
  }
}

function toItemObject(rawItem) {
  if (Array.isArray(rawItem)) {
    const [school, shortName] = rawItem
    return {
      school,
      shortName,
      itemName: `武技殊影图·${shortName}`
    }
  }
  return rawItem
}

async function main() {
  const data = JSON.parse(await readFile(dataPath, 'utf8'))
  const names = new Set()

  for (const box of data.boxes) {
    names.add(box.name)
    box.items = box.items.map(toItemObject)
    for (const item of box.items) {
      names.add(item.itemName)
    }
  }

  const lookup = new Map()
  let index = 0
  for (const name of names) {
    index += 1
    process.stdout.write(`[${index}/${names.size}] ${name}`)
    try {
      const result = await searchItem(name)
      lookup.set(name, result)
      process.stdout.write(result.itemId ? ` -> ${result.itemId}\n` : ' -> missing\n')
    } catch (error) {
      lookup.set(name, {
        itemId: null,
        iconId: null,
        jx3boxName: null,
        missing: true,
        error: error instanceof Error ? error.message : String(error)
      })
      process.stdout.write(' -> error\n')
    }
    await delay(80)
  }

  for (const box of data.boxes) {
    Object.assign(box, lookup.get(box.name))
    for (const item of box.items) {
      Object.assign(item, lookup.get(item.itemName))
    }
  }

  data.enrichedAt = new Date().toISOString()
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')

  const missing = []
  for (const box of data.boxes) {
    if (!box.itemId) {
      missing.push(box.name)
    }
    for (const item of box.items) {
      if (!item.itemId) {
        missing.push(item.itemName)
      }
    }
  }

  if (missing.length) {
    console.log(`Missing ${missing.length} items:`)
    for (const itemName of missing) {
      console.log(`- ${itemName}`)
    }
  } else {
    console.log('All item IDs resolved.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
