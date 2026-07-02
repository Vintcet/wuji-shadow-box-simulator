import { cp, mkdir, rm, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const electronDist = resolve(root, 'node_modules/electron/dist')
const outDir = resolve(root, 'out')
const target = resolve(root, 'release/武技殊影图开图模拟器-portable')
const appDir = resolve(target, 'resources/app')
const exePath = resolve(target, 'electron.exe')
const renamedExePath = resolve(target, '武技殊影图开图模拟器.exe')
const logDir = resolve(target, 'log')
const preservedLogDir = resolve(root, 'release/.wuji-shadow-log-backup')

function assertInsideRoot(path) {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  if (path !== root && !path.startsWith(normalizedRoot)) {
    throw new Error(`Refusing to operate outside project root: ${path}`)
  }
}

for (const path of [target, appDir, renamedExePath, logDir, preservedLogDir]) {
  assertInsideRoot(path)
}

if (!existsSync(electronDist)) {
  throw new Error('Missing Electron runtime. Run pnpm install first.')
}

if (!existsSync(outDir)) {
  throw new Error('Missing build output. Run pnpm build first.')
}

if (existsSync(logDir)) {
  await rm(preservedLogDir, { recursive: true, force: true })
  await cp(logDir, preservedLogDir, { recursive: true })
}

await rm(target, { recursive: true, force: true })
await mkdir(appDir, { recursive: true })
await cp(electronDist, target, { recursive: true })
if (existsSync(preservedLogDir)) {
  await cp(preservedLogDir, logDir, { recursive: true })
  await rm(preservedLogDir, { recursive: true, force: true })
}
await cp(outDir, resolve(appDir, 'out'), { recursive: true })
await writeFile(
  resolve(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'wuji-shadow-box-simulator',
      version: '0.1.0',
      type: 'module',
      main: 'out/main/index.js'
    },
    null,
    2
  )}\n`,
  'utf8'
)

if (existsSync(renamedExePath)) {
  await rm(renamedExePath, { force: true })
}
await rename(exePath, renamedExePath)

console.log(`Portable app created: ${target}`)
console.log(`Run: ${renamedExePath}`)
