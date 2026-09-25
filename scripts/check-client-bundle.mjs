/**
 * 客户端 bundle 发现检查（由 scripts/check-integration.sh 调用，cwd 必须是 web profile 目录）。
 *
 * 复刻 `@deepseek-ai/dsh-client-modules` 宿主半侧的定位逻辑：
 *   package.json → dsh.client 声明校验 → exports["./client"] → 相对包根拼接 → 读字节。
 * 只要这一串能通过，重启后浏览器就能拿到 /plugins/<row id>/client.js。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const q = String.fromCharCode(39)
const require = createRequire(`file://${process.cwd()}/`)
const problems = []

let pkgPath
try {
  pkgPath = require.resolve('dsh-termux-notify/package.json')
} catch (error) {
  console.error(`  - 解析不到 dsh-termux-notify/package.json：${error.message}`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const decl = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh.client : undefined
if (decl === undefined) {
  problems.push('package.json 缺 dsh.client 声明（dsh-client-modules 会直接跳过这个包）')
} else {
  if (decl.platform !== 'web') problems.push(`dsh.client.platform 必须是 web，实际是 ${String(decl.platform)}`)
  if (!Array.isArray(decl.inject) || decl.inject.some((entry) => typeof entry !== 'string')) {
    problems.push('dsh.client.inject 必须是字符串数组')
  }
}

const rel = pkg.exports !== null && typeof pkg.exports === 'object' ? pkg.exports['./client'] : undefined
if (typeof rel !== 'string') problems.push('exports["./client"] 缺失或不是字符串')

let bundlePath = ''
let text = ''
if (typeof rel === 'string') {
  bundlePath = join(dirname(pkgPath), rel)
  if (!existsSync(bundlePath)) {
    problems.push(`bundle 文件不存在：${bundlePath}`)
  } else {
    text = readFileSync(bundlePath, 'utf8')
    if (text.length === 0) problems.push('bundle 是空文件')
    if (!text.includes('__ModuleLoader__.load')) problems.push('bundle 没有调用 __ModuleLoader__.load')
    if (!text.includes(`${q}${pkg.name}${q}`)) problems.push(`bundle 里的 id 不是包名 ${pkg.name}，浏览器会找不到它`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`    bundle=${bundlePath} bytes=${text.length} inject=${JSON.stringify(decl.inject)}`)
