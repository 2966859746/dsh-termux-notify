/**
 * 宿主半侧接线检查（由 scripts/check-integration.sh 调用，cwd 必须是 web profile 目录）。
 *
 * 验证两件事：
 *  1. 宿主半侧能被 Node **按包名**解析并 import 出正确形状 —— 这正是 DSH loader 装载
 *     这一行的方式（row 的 name = 包名，从 profile 的 baseUrl 解析）；
 *  2. 宿主与客户端共享的常量一致：设置命名空间、检测路由、卡片的 bundle id。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const q = String.fromCharCode(39) // 单引号：避免和 shell 引号打架，也用来精确匹配 JS 字面量
const require = createRequire(`file://${process.cwd()}/`)
const problems = []

let pkgPath
try {
  pkgPath = require.resolve('dsh-termux-notify/package.json')
} catch (error) {
  console.error(`  - 浏览器/profile 侧解析不到 dsh-termux-notify/package.json：${error.message}`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

let host
try {
  const entry = require.resolve('dsh-termux-notify')
  host = await import(pathToFileURL(entry).href)
} catch (error) {
  console.error(`  - 按包名 import 宿主半侧失败：${error.message}`)
  process.exit(1)
}

if (typeof host.apply !== 'function') problems.push('apply 不是函数')
if (host.name !== 'dsh-termux-notify') problems.push(`name 不对：${host.name}`)
if (typeof host.SETTINGS_NAMESPACE !== 'string' || host.SETTINGS_NAMESPACE === '') problems.push('SETTINGS_NAMESPACE 缺失')
if (typeof host.CHECK_ROUTE_PATH !== 'string' || host.CHECK_ROUTE_PATH === '') problems.push('CHECK_ROUTE_PATH 缺失')
if (typeof host.SettingsSchema?.['~standard']?.validate !== 'function') problems.push('SettingsSchema 无效（settings.installSection 需要它）')

// 客户端与宿主共享的常量必须一致
const clientRel = pkg.exports?.['./client']
let bundle = ''
if (typeof clientRel === 'string') {
  try {
    bundle = readFileSync(join(dirname(pkgPath), clientRel), 'utf8')
  } catch (error) {
    problems.push(`读不到客户端 bundle：${error.message}`)
  }
}
if (bundle !== '') {
  for (const [label, value] of [
    ['设置命名空间', host.SETTINGS_NAMESPACE],
    ['检测路由', host.CHECK_ROUTE_PATH],
    ['bundle id', pkg.name],
  ]) {
    if (typeof value === 'string' && !bundle.includes(`${q}${value}${q}`)) {
      problems.push(`客户端里找不到${label}的字面量 ${value} —— 宿主与客户端不一致`)
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`    name=${host.name} ns=${host.SETTINGS_NAMESPACE} route=${host.CHECK_ROUTE_PATH}`)
