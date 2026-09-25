/**
 * dsh-termux-notify 的自测脚本（不依赖任何测试框架）。
 *
 *   node test/run.mjs
 *
 * 全部用假的 exec / probe / clock，不会真的发通知；只有「超时兜底」那一项会真实启动一个
 * `sleep 30` 子进程来验证硬超时与进程组清理。
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { apply, createNotifier, defaultExec, normalizeConfig, CHECK_ROUTE_PATH, DEFAULTS, SETTINGS_NAMESPACE, SettingsSchema } from '../lib/index.js'

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
const VIBRATE_BIN = '/fake/bin/termux-vibrate'

/** 从一个 argv 里读某个 flag 的值。 */
function flagValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** 造一个只记录调用的通知器环境。 */
function makeEnv(config = {}, options = {}) {
  const calls = []
  const vibrates = []
  const logs = []
  let clock = 1_000_000
  const notifier = createNotifier(config, {
    exec: (file, args, opts) => {
      // 振动调用单独收集：calls 始终只表示“通知调用”，断言不必关心两者顺序。
      if (file === VIBRATE_BIN) vibrates.push({ file, args, opts })
      else calls.push({ file, args, opts })
      if (options.execFails) return Promise.reject(new Error(options.execFails))
      return Promise.resolve('')
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    now: () => clock,
    findBin: () => (options.binFound === false ? undefined : '/fake/bin/termux-notification'),
    findOpener: () => (options.openerFound === false ? undefined : '/fake/bin/termux-open-url'),
    findVibrateBin: () => (options.vibrateBinFound === false ? undefined : VIBRATE_BIN),
    probeApp: () => (options.appInstalled === false ? false : options.appUnknown === true ? undefined : true),
  })
  return { notifier, calls, vibrates, logs, setClock: (value) => { clock = value } }
}

const session = { id: 's1', header: { id: 's1' } }

console.log('dsh-termux-notify 自测\n')

// ---------------------------------------------------------------- 配置规范化
await test('normalizeConfig 填充默认值并挡住非法值', () => {
  const cfg = normalizeConfig(undefined)
  assert.equal(cfg.enabled, DEFAULTS.enabled)
  assert.equal(cfg.priority, 'high')

  assert.equal(cfg.vibrateVia, 'termux-api', '默认走 Termux API 震动')
  assert.equal(cfg.vibrateForce, true, '默认静音也振')

  const weird = normalizeConfig({ backend: 'nope', priority: 'urgent', snippetChars: 5, execTimeoutMs: 'x', vibrateMs: '500,1000' })
  assert.equal(weird.backend, 'termux', '未知 backend 回退 termux')
  assert.equal(weird.priority, 'high', '未知 priority 回退 high')
  assert.equal(weird.snippetChars, DEFAULTS.snippetChars, '越界数字回退默认')
  assert.equal(weird.execTimeoutMs, DEFAULTS.execTimeoutMs, '非数字回退默认')
  assert.equal(weird.vibrateMs, '500,1000', '合法振动 pattern 原样保留')

  const weirdVibrate = normalizeConfig({ vibrateVia: 'nope', vibrateForce: 'yes' })
  assert.equal(weirdVibrate.vibrateVia, 'termux-api', '未知振动方式回退默认')
  assert.equal(weirdVibrate.vibrateForce, true, '非布尔值回退默认')
})

// ------------------------------------------------------------ 超时兜底（真实进程）
await test('defaultExec 超时会杀掉整个进程组而不是挂死', async () => {
  const started = Date.now()
  await assert.rejects(
    () => defaultExec('sh', ['-c', 'sleep 30'], { timeoutMs: 400 }),
    /没有返回/,
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 8000, `超时应远早于 30s 返回，实际 ${elapsed}ms`)

  // 进程组被 SIGKILL 后，ps 里可能还残留极短的一瞬（尤其机器繁忙时），所以轮询而不是只查一次。
  let stillRunning = false
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      stillRunning = /sleep 30/.test(execSync('ps -eo args 2>/dev/null || true', { encoding: 'utf8' }))
      if (!stillRunning) break
    }
  } catch {
    return // 拿不到进程表就跳过这条附加断言
  }
  assert.equal(stillRunning, false, '超时后不应残留 sleep 子进程（进程组应被 SIGKILL 清掉）')
})

// ------------------------------------------------------------------ 提问通知
await test('提问：发出通知并且把 next() 的结果原样透传', async () => {
  const { notifier, calls, vibrates, logs } = makeEnv()
  let delegated = 0
  const answer = notifier.onQuestion({
    questions: [{
      id: 'q1',
      header: '选模式',
      question: '要用哪种模式？',
      options: [{ label: '快速 (Recommended)' }, { label: '完整' }],
    }],
  }, () => { delegated += 1; return 'ANSWER' })

  assert.equal(answer, 'ANSWER', '必须透传下游回答')
  assert.equal(delegated, 1, '必须调用 next()')
  await tick()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/fake/bin/termux-notification')
  assert.equal(flagValue(calls[0].args, '--title'), 'DSH · 需要你选择')
  assert.equal(flagValue(calls[0].args, '--id'), 'dsh-question')
  const content = flagValue(calls[0].args, '--content')
  assert.ok(content.includes('选模式：要用哪种模式？'), content)
  assert.ok(content.includes('快速 (Recommended) / 完整'), content)
  assert.ok(calls[0].args.includes('--sound'), '默认带提示音')
  assert.equal(flagValue(calls[0].args, '--priority'), 'high')
  assert.equal(calls[0].args.includes('--vibrate'), false, '默认不走通知的 --vibrate')
  assert.deepEqual(vibrates[0].args, ['-d', '1000', '-f'], '默认用 termux-vibrate 振 1 秒且静音也振')
  assert.equal(flagValue(calls[0].args, '--action'), "termux-open-url 'http://127.0.0.1:3080/'",
    '默认点击通知用系统浏览器打开 DSH 页面')
  assert.equal(logs.length, 0, '正常路径不该有日志')
})

await test('振动：默认走 termux-vibrate（不受通知渠道影响），可切换或关闭', async () => {
  // 默认：通知不带 --vibrate，另起 termux-vibrate -d 1000 -f
  const on = makeEnv()
  on.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(on.calls[0].args.includes('--vibrate'), false)
  assert.deepEqual(on.vibrates[0].args, ['-d', '1000', '-f'])

  // 关掉静音强制：不带 -f
  const soft = makeEnv({ vibrateForce: false })
  soft.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.deepEqual(soft.vibrates[0].args, ['-d', '1000'])

  // vibrateMs = 0：完全不振
  const off = makeEnv({ vibrateMs: 0 })
  off.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(off.calls[0].args.includes('--vibrate'), false)
  assert.equal(off.vibrates.length, 0)

  // 显式切回通知渠道
  const viaNotification = makeEnv({ vibrateVia: 'notification' })
  viaNotification.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(flagValue(viaNotification.calls[0].args, '--vibrate'), '1000')
  assert.equal(viaNotification.vibrates.length, 0)

  // pattern 只能交给通知渠道（termux-vibrate 只能按毫秒振）
  const pattern = makeEnv({ vibrateMs: '500,1000,200' })
  pattern.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(flagValue(pattern.calls[0].args, '--vibrate'), '500,1000,200')
  assert.equal(pattern.vibrates.length, 0)

  // 没有 termux-vibrate 时退回通知渠道并告警一次
  const noBin = makeEnv({}, { vibrateBinFound: false })
  noBin.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(flagValue(noBin.calls[0].args, '--vibrate'), '1000')
  assert.equal(noBin.vibrates.length, 0)
  assert.ok(noBin.logs.some((line) => line.includes('找不到 termux-vibrate')), noBin.logs.join('\n'))
})

await test('点击：tapUrl 默认打开浏览器，留空则回到点开 Termux', async () => {
  const on = makeEnv()
  on.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(flagValue(on.calls[0].args, '--action'), "termux-open-url 'http://127.0.0.1:3080/'")

  const off = makeEnv({ tapUrl: '' })
  off.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(off.calls[0].args.includes('--action'), false, '留空时不传 --action（回到点开 Termux）')
})

await test('提问：notifyOnQuestion=false 时完全不发', async () => {
  const { notifier, calls } = makeEnv({ notifyOnQuestion: false })
  notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(calls.length, 0)
})

// ------------------------------------------------------------------ 审批通知
await test('审批：通知里带工具名与原因，并委托下游', async () => {
  const { notifier, calls } = makeEnv()
  const answer = notifier.onApproval({ agent: {}, toolName: 'bash', reason: '需要写入工作区之外' }, () => 'allowed-once')
  assert.equal(answer, 'allowed-once')
  await tick()
  assert.equal(flagValue(calls[0].args, '--title'), 'DSH · 需要授权')
  assert.equal(flagValue(calls[0].args, '--id'), 'dsh-approval')
  const content = flagValue(calls[0].args, '--content')
  assert.ok(content.includes('bash'), content)
  assert.ok(content.includes('需要写入工作区之外'), content)
})

// ---------------------------------------------------------------- 结果通知
await test('结果：turn/end 通知带会话标题、摘要与耗时', async () => {
  const { notifier, calls, setClock } = makeEnv()
  setClock(1_000_000)
  notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  notifier.onSessionEvent(session, { type: 'session/title', data: { title: '修复登录超时' } })
  notifier.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已经修好了。\n改动在 auth.ts。' }, { type: 'tool-call' }] } },
  })
  setClock(1_000_000 + 42_000)
  notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()

  assert.equal(calls.length, 1)
  assert.equal(flagValue(calls[0].args, '--title'), 'DSH · 回复完成')
  assert.equal(flagValue(calls[0].args, '--id'), 'dsh-turn')
  const content = flagValue(calls[0].args, '--content')
  const lines = content.split('\n')
  assert.equal(lines[0], '修复登录超时')
  assert.equal(lines[1], '已经修好了。 改动在 auth.ts。', '摘要应折叠换行')
  assert.equal(lines[2], '用时 42s')
})

await test('结果：error 轮次标题不同且带错误信息', async () => {
  const { notifier, calls } = makeEnv()
  notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'rate limited' } } } })
  await tick()
  assert.equal(flagValue(calls[0].args, '--title'), 'DSH · 执行出错')
  assert.ok(flagValue(calls[0].args, '--content').includes('rate limited'))
})

await test('结果：子 agent 会话默认不通知，打开开关后通知', async () => {
  const child = { id: 'c1', header: { id: 'c1', parentSession: 's1' } }
  const silent = makeEnv()
  silent.notifier.onSessionEvent(child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(silent.calls.length, 0)

  const loud = makeEnv({ notifyChildSessions: true })
  loud.notifier.onSessionEvent(child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(loud.calls.length, 1)
})

await test('结果：新轮次没有文本输出时，不沿用上一轮的陈旧摘要', async () => {
  const { notifier, calls } = makeEnv({ throttleMs: 0 })
  // 第一轮：有文本
  notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  notifier.onSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一轮的答案' }] } } })
  notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // 第二轮：只有 reasoning / tool-call，没有任何 text 块
  notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  notifier.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '这是私有推理' }, { type: 'tool-call' }] } },
  })
  notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'blocked' } } })
  await tick()

  assert.equal(calls.length, 2)
  const second = flagValue(calls[1].args, '--content')
  assert.ok(!second.includes('第一轮的答案'), `不该出现陈旧摘要：${second}`)
  assert.ok(!second.includes('这是私有推理'), `不该把 reasoning 泄漏到通知里：${second}`)
})

await test('结果：minTurnDurationMs 过滤掉过短的轮次', async () => {
  const { notifier, calls, setClock } = makeEnv({ minTurnDurationMs: 10_000 })
  setClock(0)
  notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  setClock(3_000)
  notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(calls.length, 0, '3s < 10s，应被过滤')
})

await test('结果：throttleMs 抑制重复内容', async () => {
  const { notifier, calls } = makeEnv({ throttleMs: 5_000, includeSnippet: false })
  const event = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  notifier.onSessionEvent(session, event)
  notifier.onSessionEvent(session, event)
  await tick()
  assert.equal(calls.length, 1, '第二次同内容应被节流')
})

// ------------------------------------------------------------ 通道不可用时的行为
await test('通道：找不到 termux-notification 时停用且不再尝试', async () => {
  const { notifier, calls, logs } = makeEnv({}, { binFound: false })
  notifier.startupCheck()
  notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(notifier.state.degraded, true)
  assert.ok(logs.some((line) => line.includes('pkg install termux-api')), logs.join('\n'))
})

await test('通道：Termux:API 应用缺失时启动即停用（避免挂起）', async () => {
  const { notifier, calls, logs } = makeEnv({}, { appInstalled: false })
  notifier.startupCheck()
  await tick()
  await tick()
  assert.equal(notifier.state.degraded, true, '必须停用')
  assert.ok(logs.some((line) => line.includes('Termux:API 应用未安装')), logs.join('\n'))
  notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(calls.length, 0, '停用后不应再执行命令')
})

await test('通道：backend=command 走自定义命令并做 shell 转义', async () => {
  const { notifier, calls } = makeEnv({ backend: 'command', command: 'notify {title} {content}' })
  notifier.onQuestion({ questions: [{ id: 'q', question: "it's a test" }] }, () => 'A')
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'sh')
  assert.equal(calls[0].args[0], '-c')
  assert.ok(calls[0].args[1].startsWith('notify '), calls[0].args[1])
  assert.ok(calls[0].args[1].includes(`'\\''`), '单引号必须转义')
})

await test('通道：dryRun 只写日志不发命令', async () => {
  const { notifier, calls, logs } = makeEnv({ dryRun: true })
  notifier.onQuestion({ questions: [{ id: 'q', question: '要选吗' }] }, () => 'A')
  await tick()
  assert.equal(calls.length, 0)
  assert.ok(logs.some((line) => line.includes('[dry-run]') && line.includes('需要你选择')), logs.join('\n'))
})

// -------------------------------------------------------------- 设置命名空间
await test('SettingsSchema 的默认值与 DEFAULTS 完全一致（防漂移）', () => {
  const schemaDefaults = SettingsSchema['~standard'].validate(undefined).value
  assert.deepEqual(Object.keys(schemaDefaults).sort(), Object.keys(DEFAULTS).sort(),
    'schema 字段集合必须与 DEFAULTS 一致')
  for (const key of Object.keys(DEFAULTS)) {
    assert.deepEqual(schemaDefaults[key], DEFAULTS[key], `字段 ${key} 的 schema 默认值偏离 DEFAULTS`)
  }
})

await test('SettingsSchema 不可失败：任意字段值都被接受，缺字段补默认', () => {
  const out = SettingsSchema['~standard'].validate({ snippetChars: -5, titlePrefix: 42, backend: 'whatever' })
  assert.equal(out.issues, undefined, 'schema 不应报错（宿主 register 会立即解析，报错会连累激活）')
  assert.equal(out.value.titlePrefix, 42, '任何值都原样通过')
  assert.equal(out.value.enabled, DEFAULTS.enabled, '缺字段补默认')
  assert.equal(normalizeConfig(out.value).snippetChars, DEFAULTS.snippetChars, '越界值最终回退默认')
  assert.equal(normalizeConfig(out.value).titlePrefix, DEFAULTS.titlePrefix, '类型错误最终回退默认')
})

await test('apply：设置接线抛错也不会影响插件激活与观测点', async () => {
  const hooks = new Map()
  const logs = []
  const ctx = {
    get: (key) => (key === 'logger' ? { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`) } : undefined),
    on(hookName, callback, options) {
      const list = hooks.get(hookName) ?? []
      if (options === true || options?.prepend) list.unshift(callback)
      else list.push(callback)
      hooks.set(hookName, list)
      return () => {}
    },
    inject(deps, callback) {
      callback({ settings: { installSection: () => { throw new Error('boom') } } })
      return () => {}
    },
  }

  apply(ctx, { dryRun: true }) // 不应抛出
  assert.equal(hooks.get('user-questions/request').length, 1, '观测点仍须注册成功')
  assert.equal(hooks.get('session/event').length, 1)
  assert.ok(logs.some((line) => line.includes('注册设置命名空间失败')), logs.join('\n'))
})

await test('apply：接入设置命名空间，改动即时生效（无需重启）', async () => {
  const hooks = new Map()
  const logs = []
  const installs = []
  const ctx = {
    get: (key) => (key === 'logger'
      ? { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`) }
      : undefined),
    on(hookName, callback, options) {
      const list = hooks.get(hookName) ?? []
      if (options === true || options?.prepend) list.unshift(callback)
      else list.push(callback)
      hooks.set(hookName, list)
      return () => {}
    },
    inject(deps, callback) {
      if (deps.includes('settings')) {
        callback({ settings: { installSection: (...args) => installs.push(args) } })
      }
      return () => {}
    },
  }

  apply(ctx, { dryRun: true })
  assert.equal(installs.length, 1, '必须注册一个设置命名空间')
  const [owner, ns, schema, entry, settingsHooks] = installs[0]
  assert.equal(owner, ctx)
  assert.equal(ns, SETTINGS_NAMESPACE)
  assert.equal(schema, SettingsSchema)
  assert.deepEqual(entry, { dryRun: true }, '组合配置作为 base 传入')

  // 设置服务解析出新的用户配置
  settingsHooks.setSource(() => ({ ...DEFAULTS, dryRun: true, titlePrefix: '来自设置页' }))
  hooks.get('user-questions/request')[0]({ questions: [{ id: 'q', question: '要选吗' }] }, () => 'NEXT')
  await tick()
  assert.ok(logs.some((line) => line.includes('来自设置页 · 需要你选择')), `改动没有生效：\n${logs.join('\n')}`)

  // 服务消失时回退组合配置
  settingsHooks.setSource(() => ({ ...DEFAULTS, dryRun: true }))
  settingsHooks.onChange()
  logs.length = 0
  hooks.get('user-questions/request')[0]({ questions: [{ id: 'q', question: '要选吗' }] }, () => 'NEXT')
  await tick()
  assert.ok(logs.some((line) => line.includes('DSH · 需要你选择')), `没有回退组合配置：\n${logs.join('\n')}`)
})

// ------------------------------------------------------------------ apply 接线
await test('apply：注册三个观测点，提问监听器 prepend 且仍会委托', async () => {
  const hooks = new Map()
  const logs = []
  const ctx = {
    get: (key) => (key === 'logger'
      ? { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`) }
      : undefined),
    on(hookName, callback, options) {
      const list = hooks.get(hookName) ?? []
      if (options === true || options?.prepend) list.unshift(callback)
      else list.push(callback)
      hooks.set(hookName, list)
      return () => {}
    },
    inject: () => () => {},
  }
  // 先放一个“已有回答者”，验证插件是 prepend 到它前面
  hooks.set('user-questions/request', [() => 'EXISTING'])

  apply(ctx, { dryRun: true })

  assert.equal(hooks.get('user-questions/request').length, 2)
  assert.equal(hooks.get('approval/request').length, 1)
  assert.equal(hooks.get('session/event').length, 1)
  assert.equal(hooks.get('session/disposed').length, 1)

  const questionHooks = hooks.get('user-questions/request')
  let notifierIndex = -1
  for (let i = 0; i < questionHooks.length; i += 1) {
    const before = logs.length
    questionHooks[i]({ questions: [{ id: 'q', question: '要选吗' }] }, () => 'NEXT')
    if (logs.length > before) notifierIndex = i
  }
  assert.equal(notifierIndex, 0, '插件监听器必须 prepend 到最前面，否则要等用户答完才触发')

  // 走一遍会话事件，确认 turn/end 也能穿过 apply 的接线
  const fire = (event) => hooks.get('session/event')[0](session, event)
  fire({ type: 'turn/start', data: { turn: 1 } })
  fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成了' }] } } })
  fire({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.ok(logs.some((line) => line.includes('回复完成')), logs.join('\n'))
  assert.ok(logs.some((line) => line.includes('完成了')), logs.join('\n'))
})

// ------------------------------------------------------------------ 环境检测
const stepOf = (result, key) => result.steps.find((step) => step.key === key)

await test('环境检测：一切正常 → ok，且每个必需项都是 ok', async () => {
  const { notifier } = makeEnv({ dryRun: false })
  const result = await notifier.runEnvironmentCheck()
  assert.equal(result.ok, true)
  assert.equal(result.sent, false)
  assert.equal(result.summary, '环境就绪')
  for (const key of ['config', 'command', 'app', 'tap', 'vibrate', 'runtime']) {
    assert.equal(stepOf(result, key)?.status, 'ok', `${key} 应为 ok：${JSON.stringify(stepOf(result, key))}`)
  }
  assert.match(stepOf(result, 'command').detail, /termux-notification/)
  assert.match(stepOf(result, 'tap').detail, /termux-open-url/)
})

await test('环境检测：缺命令或缺应用时给出可执行的修复提示', async () => {
  const noBin = await makeEnv({}, { binFound: false }).notifier.runEnvironmentCheck()
  assert.equal(noBin.ok, false)
  assert.equal(stepOf(noBin, 'command').status, 'fail')
  assert.match(stepOf(noBin, 'command').hint, /pkg install termux-api/)

  const noApp = await makeEnv({}, { appInstalled: false }).notifier.runEnvironmentCheck()
  assert.equal(noApp.ok, false)
  assert.equal(stepOf(noApp, 'app').status, 'fail')
  assert.match(stepOf(noApp, 'app').hint, /f-droid\.org/)

  const unknownApp = await makeEnv({}, { appUnknown: true }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(unknownApp, 'app').status, 'warn', '判断不了时是提醒而不是失败')
  assert.equal(unknownApp.ok, true)
})

await test('环境检测：tapUrl 为空或缺 termux-open-url 时提醒点击行为', async () => {
  const noTap = await makeEnv({ tapUrl: '' }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(noTap, 'tap').status, 'warn')
  assert.match(stepOf(noTap, 'tap').detail, /打开 Termux 应用/)

  const noOpener = await makeEnv({}, { openerFound: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(noOpener, 'tap').status, 'warn')
  assert.match(stepOf(noOpener, 'tap').hint, /termux-tools/)
})

await test('环境检测：震动那一项说清会怎么振、以及为什么可能不振', async () => {
  const viaApi = await makeEnv().notifier.runEnvironmentCheck()
  assert.equal(stepOf(viaApi, 'vibrate').status, 'ok')
  assert.match(stepOf(viaApi, 'vibrate').detail, /termux-vibrate -d 1000 -f/)
  assert.match(stepOf(viaApi, 'vibrate').hint, /静音/)

  const soft = await makeEnv({ vibrateForce: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(soft, 'vibrate').status, 'ok')
  assert.match(stepOf(soft, 'vibrate').hint, /静音/)
  assert.equal(/ -f/.test(stepOf(soft, 'vibrate').detail), false, '不带 -f 时命令行里不应出现 -f')

  const off = await makeEnv({ vibrateMs: 0 }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(off, 'vibrate').status, 'warn')
  assert.match(stepOf(off, 'vibrate').detail, /已关闭/)

  const viaNotification = await makeEnv({ vibrateVia: 'notification' }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(viaNotification, 'vibrate').status, 'warn')
  assert.match(stepOf(viaNotification, 'vibrate').hint, /通知渠道/)

  const pattern = await makeEnv({ vibrateMs: '500,1000' }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(pattern, 'vibrate').status, 'warn')
  assert.match(stepOf(pattern, 'vibrate').detail, /pattern/)

  const noBin = await makeEnv({}, { vibrateBinFound: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(noBin, 'vibrate').status, 'fail')
  assert.match(stepOf(noBin, 'vibrate').hint, /pkg install termux-api/)
})

await test('环境检测：dry-run / 关闭 / command 通道都会如实说明', async () => {
  const dry = await makeEnv({ dryRun: true }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(dry, 'config').status, 'warn')
  assert.match(stepOf(dry, 'config').detail, /dry-run/)

  const off = await makeEnv({ enabled: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(off, 'config').status, 'warn')

  const command = await makeEnv({ backend: 'command', command: '' }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(command, 'channel').status, 'fail')
  assert.match(stepOf(command, 'channel').hint, /自定义命令模板/)

  const commandOk = await makeEnv({ backend: 'command', command: 'notify {title}' }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(commandOk, 'channel').status, 'ok')
  assert.equal(stepOf(commandOk, 'command'), undefined, 'command 通道不做 Termux 检测')
})

await test('环境检测：试发成功会复位“已停用”，失败则报出来', async () => {
  const ok = makeEnv()
  ok.notifier.state.degraded = true
  const result = await ok.notifier.runEnvironmentCheck({ sendTest: true })
  assert.equal(stepOf(result, 'send').status, 'ok')
  assert.equal(result.sent, true)
  assert.equal(result.summary, '通道可用，通知已经发出')
  assert.equal(ok.notifier.state.degraded, false, '试发成功应解除停用（装好 APK 后不必重启）')
  assert.equal(flagValue(ok.calls[0].args, '--id'), 'dsh-test', '测试通知用独立 id')
  assert.match(flagValue(ok.calls[0].args, '--title'), /环境检测/)

  const bad = await makeEnv({}, { execFails: '在 8000ms 内没有返回' })
  const failed = await bad.notifier.runEnvironmentCheck({ sendTest: true })
  assert.equal(stepOf(failed, 'send').status, 'fail')
  assert.match(stepOf(failed, 'send').detail, /没有返回/)
  assert.equal(failed.ok, false)
})

// ------------------------------------------------------------------ 检测路由
await test('检测路由：注册 exact 路由，走信任栅栏 + 方法校验 + JSON 响应', async () => {
  const hooks = new Map()
  const routes = []
  const routeCtx = {
    effect: (fn) => { fn(); return () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: (req) => (req.headers['x-reject'] === 'yes' ? 403 : undefined) },
  }
  const ctx = {
    get: () => undefined,
    on(hookName, callback) { hooks.set(hookName, [callback]); return () => {} },
    inject(deps, callback) {
      if (deps.includes('webServer') && deps.includes('connection')) callback(routeCtx)
      return () => {}
    },
  }
  apply(ctx, { dryRun: false })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, CHECK_ROUTE_PATH)
  assert.equal(typeof routes[0].handler, 'function')

  const makeRes = () => ({
    statusCode: undefined,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk) },
  })
  const makeReq = ({ method = 'POST', body = '', headers = {} } = {}) => ({
    method,
    url: CHECK_ROUTE_PATH,
    headers,
    resume() {},
    async *[Symbol.asyncIterator]() { if (body !== '') yield Buffer.from(body) },
  })

  // 信任栅栏：被拒的请求直接返回状态码，不进入检测
  const rejected = makeRes()
  await routes[0].handler(makeReq({ headers: { 'x-reject': 'yes' } }), rejected)
  assert.equal(rejected.statusCode, 403)

  // 方法校验
  const wrongMethod = makeRes()
  await routes[0].handler(makeReq({ method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  // 正常检测（sendTest=false，不会真发通知）
  const ok = makeRes()
  await routes[0].handler(makeReq({ body: JSON.stringify({ sendTest: false }) }), ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(ok.headers['cache-control'], 'no-store')
  const payload = JSON.parse(ok.body)
  assert.ok(Array.isArray(payload.steps) && payload.steps.length > 0)
  assert.equal(typeof payload.summary, 'string')
  assert.ok(payload.steps.some((step) => step.key === 'command'))

  // 空 body 也要能用（等价于只检测、不试发）
  const emptyBody = makeRes()
  await routes[0].handler(makeReq({ body: '' }), emptyBody)
  assert.equal(emptyBody.statusCode, 200)
})

console.log(`\n${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  for (const { title, error } of failures) console.error(`\n[${title}]\n${error?.stack ?? error}`)
  process.exit(1)
}
