/**
 * 真实 Cordis 集成测试：用真的 `@deepseek-ai/cordis` 加载本插件，验证
 * 「模块形状能被 loader 接受」「waterfall prepend + 委托」「Agent scope 派发也能收到」
 * 这些光靠假 ctx 测不出来的行为。
 *
 *   node test/integration.mjs
 *
 * 用 dryRun，不会真的发通知。
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.js'

let passed = 0
let failed = 0
const failures = []

async function test(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failed += 1
    failures.push({ title, error })
    console.log(`  FAIL ${title}\n       ${error?.message ?? error}`)
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

const logs = []
const ctx = new Context()
ctx.logger.exporter({
  levels: { default: 4 },
  export: (message) => logs.push(`${message.type}: ${message.args.join(' ')}`),
})

const text = () => logs.join('\n')

console.log('dsh-termux-notify 集成测试（真实 cordis）\n')

await test('loader 接受模块形状并能启动', async () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'dsh-termux-notify')
  const fiber = ctx.registry.plugin(plugin, { dryRun: true, appProbe: false })
  await fiber
  assert.ok(text().includes('dry-run 模式'), `启动日志缺失：\n${text()}`)
})

await test('无 scope 派发：监听器发通知并把结果透传给下游', async () => {
  let delegated = 0
  const answer = await ctx.waterfall(
    'user-questions/request',
    { questions: [{ id: 'q1', question: 'UNSCOPED-Q', options: [{ label: '甲' }, { label: '乙' }] }] },
    () => { delegated += 1; return Promise.resolve('NO_PROVIDER') },
  )
  await tick()
  assert.equal(answer, 'NO_PROVIDER', '必须把下游结果原样返回')
  assert.equal(delegated, 1, '必须委托下游')
  assert.ok(text().includes('UNSCOPED-Q'), `通知未发出：\n${text()}`)
  assert.ok(text().includes('甲 / 乙'), `选项未渲染：\n${text()}`)
})

await test('Agent scope 派发：未打 scope 标签的插件监听器依然收得到', async () => {
  let delegated = 0
  const carrier = scopeTarget({}, {})
  const answer = await ctx.waterfall(
    carrier,
    'user-questions/request',
    { questions: [{ id: 'q2', question: 'SCOPED-Q' }] },
    () => { delegated += 1; return Promise.resolve('NO_PROVIDER') },
  )
  await tick()
  assert.equal(answer, 'NO_PROVIDER')
  assert.equal(delegated, 1, '必须委托下游')
  assert.ok(text().includes('SCOPED-Q'), `scope 派发时通知没有发出（说明监听器被过滤掉了）：\n${text()}`)
})

await test('审批 waterfall 同样被观测到', async () => {
  let delegated = 0
  const answer = await ctx.waterfall(
    scopeTarget({}, {}),
    'approval/request',
    { agent: {}, toolName: 'bash', reason: '越界写入' },
    () => { delegated += 1; return Promise.resolve('unavailable') },
  )
  await tick()
  assert.equal(answer, 'unavailable')
  assert.equal(delegated, 1)
  assert.ok(text().includes('⚠️ 需要确认'), text())
  assert.ok(text().includes('越界写入'), text())
})

await test('session/event 事件流：turn/end 触发结果通知', async () => {
  const session = { id: 'sess-integration', header: { id: 'sess-integration' } }
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', session, { type: 'session/title', data: { title: '集成测试会话' } })
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '集成测试的结果摘要' }] } },
  })
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.ok(text().includes('✅ 任务完成'), text())
  assert.ok(text().includes('集成测试会话'), text())
  assert.ok(text().includes('集成测试的结果摘要'), text())
})

await test('卸载插件后监听器随之消失（fiber effect 正确回收）', async () => {
  const before = logs.length
  await ctx.fiber.dispose()
  await ctx.waterfall(
    'user-questions/request',
    { questions: [{ id: 'q3', question: 'AFTER-DISPOSE-Q' }] },
    () => Promise.resolve('NO_PROVIDER'),
  )
  await tick()
  assert.equal(logs.length, before, 'dispose 后不应再产生通知日志')
})

console.log(`\n${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  for (const { title, error } of failures) console.error(`\n[${title}]\n${error?.stack ?? error}`)
  process.exit(1)
}
