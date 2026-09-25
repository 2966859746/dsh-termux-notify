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
import { apply, createNotifier, defaultExec, normalizeConfig, toolLabel, CHANNEL_ID, CHANNEL_NAME, CHECK_ROUTE_PATH, DEFAULTS, SETTINGS_NAMESPACE, SettingsSchema } from '../lib/index.js'

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
/** 读 `--es <key> <value>` 形式里某个 key 的值（am 的 extras 是三元组，flagValue 读不了）。 */
function esValue(args, key) {
  for (let i = 0; i + 2 < args.length; i += 1) {
    if (args[i] === '--es' && args[i + 1] === key) return args[i + 2]
  }
  return undefined
}

const VIBRATE_BIN = '/fake/bin/termux-vibrate'
const TTS_BIN = '/fake/bin/termux-tts-speak'
const CHANNEL_HELPER = '/fake/libexec/termux-api'
const REMOVE_BIN = '/fake/bin/termux-notification-remove'

/** 从一个 argv 里读某个 flag 的值。 */
function flagValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** 造一个只记录调用的通知器环境。 */
function makeEnv(config = {}, options = {}) {
  // calls 始终只表示「通知调用」，其余按用途分桶，断言就不必关心彼此顺序。
  const calls = []
  const vibrates = []
  const voices = []
  const channels = []
  const removals = []
  const engines = []
  const order = []
  const logs = []
  let releaseTts = () => {}
  let clock = 1_000_000
  const notifier = createNotifier(config, {
    exec: (file, args, opts) => {
      if (file === VIBRATE_BIN) {
        vibrates.push({ file, args, opts })
        order.push('vibrate')
      } else if (file === TTS_BIN) {
        voices.push({ file, args, opts })
        order.push('voice')
        // ttsSlow：挂住不返回，用来验证「上一条还在念时跳过新的」
        if (options.ttsSlow) return new Promise((resolve) => { releaseTts = resolve })
        // ttsFails：模拟引擎卡住被超时杀掉
        if (options.ttsFails) return Promise.reject(new Error('termux-tts-speak 在 30000ms 内没有返回'))
      } else if (file === 'termux-tts-engines') {
        engines.push({ file, args, opts })
        return Promise.resolve(options.enginesMissing ? '' : '[{"name":"com.example.tts","label":"Test TTS","default":true}]')
      } else if (file === REMOVE_BIN) {
        removals.push({ file, args, opts })
        order.push('remove')
      } else if (/libexec\/termux-api$/.test(file)) {
        channels.push({ file, args, opts })
        order.push('channel')
        if (options.channelFails) return Promise.reject(new Error('channel boom'))
        if (options.channelSaysNo) return Promise.resolve('Could not create/delete.')
        return Promise.resolve(`Created channel with id "${CHANNEL_ID}" and name "${CHANNEL_NAME}".`)
      } else {
        calls.push({ file, args, opts })
        order.push('notify')
      }
      if (options.execFails) return Promise.reject(new Error(options.execFails))
      return Promise.resolve('')
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    now: () => clock,
    findBin: () => (options.binFound === false ? undefined : '/fake/bin/termux-notification'),
    findOpener: () => (options.openerFound === false ? undefined : '/fake/bin/termux-open-url'),
    findVibrateBin: () => (options.vibrateBinFound === false ? undefined : VIBRATE_BIN),
    findTtsBin: () => (options.ttsFound === false ? undefined : TTS_BIN),
    findRemoveBin: () => (options.removeFound === false ? undefined : REMOVE_BIN),
    channelHelper: () => (options.channelHelperFound === false ? undefined : CHANNEL_HELPER),
    probeApp: () => (options.appInstalled === false ? false : options.appUnknown === true ? undefined : true),
  })
  return { notifier, calls, vibrates, voices, channels, removals, engines, order, logs, releaseTts: () => releaseTts(), setClock: (value) => { clock = value } }
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

  const weird = normalizeConfig({ priority: 'urgent', snippetChars: 5, execTimeoutMs: 'x', vibrateMs: '500,1000' })
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
  assert.equal(flagValue(calls[0].args, '--title'), '❓ 需要选择')
  assert.ok(flagValue(calls[0].args, '--id').startsWith('dsh-question-'), '需要你操作的用全新 tag，才会弹横幅')
  const content = flagValue(calls[0].args, '--content')
  assert.ok(content.includes('选模式：要用哪种模式？'), content)
  assert.ok(content.includes('选项：快速 (Recommended) / 完整'), content)
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
  assert.equal(flagValue(calls[0].args, '--title'), '⚠️ 需要确认')
  assert.ok(flagValue(calls[0].args, '--id').startsWith('dsh-approval-'))
  const content = flagValue(calls[0].args, '--content')
  assert.ok(content.includes('工具：命令行'), `bash 应映射成中文口语：${content}`)
  assert.ok(content.includes('需要写入工作区之外'), content)
})

await test('审批：没有工具信息时按权限请求呈现', async () => {
  const { notifier, calls } = makeEnv()
  notifier.onApproval({ agent: {}, reason: '访问工作区之外的文件' }, () => 'unavailable')
  await tick()
  assert.equal(flagValue(calls[0].args, '--title'), '🔐 权限请求')
  assert.equal(flagValue(calls[0].args, '--content'), '访问工作区之外的文件')
  assert.ok(flagValue(calls[0].args, '--id').startsWith('dsh-permission-'))
})

await test('工具名映射：英文工具名转中文口语，映射不到就原样保留', () => {
  assert.equal(toolLabel('bash'), '命令行')
  assert.equal(toolLabel('Bash'), '命令行', '大小写不敏感')
  assert.equal(toolLabel('str_replace_editor'), '编辑文件')
  assert.equal(toolLabel('str-replace-editor'), '编辑文件')
  assert.equal(toolLabel('read'), '读取文件')
  assert.equal(toolLabel('web_search'), '网络搜索')
  assert.equal(toolLabel('mcp__foo__bash'), '命令行', '带包装的名字取最后一段再映射')
  assert.equal(toolLabel('MyCustomTool'), 'MyCustomTool', '映射不到就原样用')
  assert.equal(toolLabel(''), '工具')
  assert.equal(toolLabel(undefined), '工具')
})

// --------------------------------------------------------------- 悬浮通知
await test('悬浮通知：先建 HIGH 重要性通道，再在通知里引用它', async () => {
  const env = makeEnv()
  env.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()

  assert.equal(env.channels.length, 1, '应先建通道')
  const cargs = env.channels[0].args
  assert.equal(cargs[0], 'NotificationChannel')
  assert.equal(esValue(cargs, 'id'), CHANNEL_ID)
  assert.equal(esValue(cargs, 'name'), CHANNEL_NAME)
  assert.equal(esValue(cargs, 'priority'), 'high', '重要性必须显式传 high（包装脚本不传，默认不悬浮）')

  assert.equal(flagValue(env.calls[0].args, '--channel'), CHANNEL_ID)
  assert.ok(env.order.indexOf('channel') < env.order.indexOf('notify'), '必须先建通道再引用它')
})

await test('悬浮通知：关掉时不建通道也不传 --channel', async () => {
  const env = makeEnv({ headsUp: false })
  env.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(env.channels.length, 0)
  assert.equal(env.calls[0].args.includes('--channel'), false)
  assert.equal(env.logs.length, 0)
})

await test('悬浮通知：通道建不成时退回默认通道（绝不引用不存在的通道）', async () => {
  // helper 不存在
  const noHelper = makeEnv({}, { channelHelperFound: false })
  noHelper.notifier.onQuestion({ questions: [{ id: 'q1', question: 'q1' }] }, () => 'A')
  await tick()
  assert.equal(noHelper.channels.length, 0)
  assert.equal(noHelper.calls[0].args.includes('--channel'), false)
  assert.ok(noHelper.logs.some((line) => line.includes('找不到 Termux:API 的 libexec/termux-api')), noHelper.logs.join('\n'))
  // 再发一次仍然只告警一次
  noHelper.notifier.onQuestion({ questions: [{ id: 'q2', question: 'q2' }] }, () => 'A')
  await tick()
  assert.equal(noHelper.logs.filter((line) => line.includes('libexec/termux-api')).length, 1)

  // 助手"成功返回"但文本说建不了（助手把失败也当数据返回）
  const saysNo = makeEnv({}, { channelSaysNo: true })
  saysNo.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(saysNo.calls[0].args.includes('--channel'), false, '建不成还引用的话通知会被系统丢弃')
  assert.ok(saysNo.logs.some((line) => line.includes('创建悬浮通知通道失败')), saysNo.logs.join('\n'))

  // 调用直接抛错
  const fails = makeEnv({}, { channelFails: true })
  fails.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(fails.calls[0].args.includes('--channel'), false)
  assert.ok(fails.logs.some((line) => line.includes('创建悬浮通知通道失败')))
})

await test('优先级分层：需要你操作用 high+悬浮通道，结果类用 default 且不弹横幅', async () => {
  const env = makeEnv({ throttleMs: 0 })
  env.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(flagValue(env.calls[0].args, '--priority'), 'high', '需要你操作 → 高优先级')
  assert.equal(flagValue(env.calls[0].args, '--channel'), CHANNEL_ID)
  assert.equal(env.calls[0].args.includes('--group'), false, '悬浮时不分组：分组在不少 ROM 上会抑制横幅')

  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(flagValue(env.calls[1].args, '--priority'), 'default', '结果类 → 默认优先级')
  assert.equal(env.calls[1].args.includes('--channel'), false, '结果类不弹横幅、不打断')
  assert.equal(flagValue(env.calls[1].args, '--group'), 'dsh', '结果类仍按分组折叠')
})

await test('悬浮通知：需要你操作的每次都换新 tag；悬浮通道 id 可配置', async () => {
  const env = makeEnv({ throttleMs: 0, headsUpChannel: 'dsh-heads-up2' })
  env.notifier.onQuestion({ questions: [{ id: 'q1', question: 'q1' }] }, () => 'A')
  await tick()
  env.notifier.onQuestion({ questions: [{ id: 'q2', question: 'q2' }] }, () => 'A')
  await tick()
  const first = flagValue(env.calls[0].args, '--id')
  const second = flagValue(env.calls[1].args, '--id')
  assert.ok(first.startsWith('dsh-question-') && second.startsWith('dsh-question-'))
  assert.notEqual(first, second, '同 tag 重发会被当成更新，Android 不再弹横幅')
  assert.equal(esValue(env.channels[0].args, 'id'), 'dsh-heads-up2', '通道 id 用配置值')
  assert.equal(flagValue(env.calls[0].args, '--channel'), 'dsh-heads-up2')
})

await test('悬浮通知：通道只建一次（缓存）', async () => {
  const env = makeEnv({ throttleMs: 0 })
  env.notifier.onQuestion({ questions: [{ id: 'q1', question: 'q1' }] }, () => 'A')
  await tick()
  env.notifier.onQuestion({ questions: [{ id: 'q2', question: 'q2' }] }, () => 'A')
  await tick()
  assert.equal(env.calls.length, 2)
  assert.equal(env.channels.length, 1, '通道应缓存，不该每条通知都重建')
  assert.equal(flagValue(env.calls[1].args, '--channel'), CHANNEL_ID)
})

// --------------------------------------------------------------- 清空旧通知
await test('清空旧通知：新一轮开始时撤销上一轮发过的 tag', async () => {
  const env = makeEnv({ throttleMs: 0 })
  env.notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  const firstTag = flagValue(env.calls[0].args, '--id')
  assert.equal(env.removals.length, 0, '第一轮开始时还没有可清的')

  env.notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  await tick()
  await tick()
  assert.deepEqual(env.removals.map((call) => call.args[0]), [firstTag], '只撤自己发过的那条，且用真正发出去的 tag')
})

await test('清空旧通知：只撤本插件发过的，失败的通知不登记', async () => {
  const env = makeEnv({ throttleMs: 0 }, { execFails: 'boom' })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  // 发送失败 → 没有 tag 被登记
  const cleared = await env.notifier.clearPostedNotifications()
  assert.equal(cleared, 0)
  assert.equal(env.removals.length, 0)
})

await test('清空旧通知：子会话的轮次不会清掉主会话的提醒', async () => {
  const env = makeEnv({ throttleMs: 0 })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  const child = { id: 'c1', header: { id: 'c1', parentSession: 's1' } }
  env.notifier.onSessionEvent(child, { type: 'turn/start', data: { turn: 1 } })
  await tick()
  await tick()
  assert.equal(env.removals.length, 0, '子 agent 轮次很频繁，不能清掉主会话')

  env.notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  await tick()
  await tick()
  assert.equal(env.removals.length, 1, '主会话新一轮才清')
})

await test('清空旧通知：在浏览器里答完提问后立刻撤掉那条提醒', async () => {
  const env = makeEnv({ throttleMs: 0 })
  let resolveAnswer
  const answer = new Promise((resolve) => { resolveAnswer = resolve })
  // 模拟 waterfall：通知发出 → 用户过一会儿才在浏览器里回答
  const result = env.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => answer)
  await tick()
  assert.equal(env.calls.length, 1, '通知应已发出')
  const tag = flagValue(env.calls[0].args, '--id')
  assert.equal(env.removals.length, 0, '还没回答，通知应留着')

  resolveAnswer('ANSWER')
  assert.equal(await result, 'ANSWER', '落定值必须原样透传给 waterfall')
  await tick()
  await tick()
  assert.deepEqual(env.removals.map((call) => call.args[0]), [tag], '回答后立刻撤销')
})

await test('清空旧通知：审批被决定后同样撤掉', async () => {
  const env = makeEnv({ throttleMs: 0 })
  let decide
  const pending = new Promise((resolve) => { decide = resolve })
  const result = env.notifier.onApproval({ agent: {}, toolName: 'bash' }, () => pending)
  await tick()
  const tag = flagValue(env.calls[0].args, '--id')
  decide('allowed-once')
  assert.equal(await result, 'allowed-once')
  await tick()
  await tick()
  assert.deepEqual(env.removals.map((call) => call.args[0]), [tag])
})

await test('清空旧通知：提问被拒绝/无回答者时也会清掉（提醒已无效）', async () => {
  const env = makeEnv({ throttleMs: 0 })
  const result = env.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => Promise.reject(new Error('NO_PROVIDER')))
  await assert.rejects(() => result, /NO_PROVIDER/)
  await tick()
  await tick()
  assert.equal(env.removals.length, 1, '失败落定也要清')
})

await test('清空旧通知：关掉开关就完全不动', async () => {
  const env = makeEnv({ throttleMs: 0, clearStale: false })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  env.notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  await tick()
  await tick()
  assert.equal(env.removals.length, 0)
})

await test('清空旧通知：缺 termux-notification-remove 时告警一次且不影响运行', async () => {
  const env = makeEnv({ throttleMs: 0 }, { removeFound: false })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  env.notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  env.notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 3 } })
  await tick()
  await tick()
  assert.equal(env.removals.length, 0)
  assert.equal(env.logs.filter((line) => line.includes('termux-notification-remove')).length, 1, '只告警一次')
})

await test('清空旧通知：手动调用返回撤销条数，清完即空', async () => {
  const env = makeEnv({ throttleMs: 0, clearStale: false })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } })
  await tick()
  assert.equal(env.calls.length, 2)
  assert.equal(await env.notifier.clearPostedNotifications(), 2)
  assert.equal(env.removals.length, 2)
  assert.equal(await env.notifier.clearPostedNotifications(), 0, '清完就没有可撤的了')
})

// --------------------------------------------------------------- 语音通知
await test('语音通知：默认关闭；打开后按模板调 termux-tts-speak', async () => {
  const off = makeEnv()
  off.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(off.voices.length, 0, '默认不播报')

  const on = makeEnv({ voice: true })
  on.notifier.onQuestion({ questions: [{ id: 'q', header: '选模式', question: '要用哪种模式？' }] }, () => 'A')
  await tick()
  assert.equal(on.voices.length, 1)
  assert.deepEqual(on.voices[0].args, ['-r', '1', '-p', '1', '需要你选择，选模式：要用哪种模式？'],
    '默认念场景短句（动作 + 对象），并显式带语速/音调')

  const lang = makeEnv({ voice: true, voiceLanguage: 'zh' })
  lang.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.deepEqual(lang.voices[0].args, ['-l', 'zh', '-r', '1', '-p', '1', '需要你选择，q'])

  const tpl = makeEnv({ voice: true, voiceTemplate: '{title}。{content}' })
  tpl.notifier.onQuestion({ questions: [{ id: 'q', question: '要用哪种模式？' }] }, () => 'A')
  await tick()
  const tplSpoken = tpl.voices[0].args[tpl.voices[0].args.length - 1]
  assert.ok(tplSpoken.startsWith('❓ 需要选择。'), tplSpoken)
  assert.ok(tplSpoken.includes('要用哪种模式？'), tplSpoken)

  const noTts = makeEnv({ voice: true }, { ttsFound: false })
  noTts.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  assert.equal(noTts.voices.length, 0)
  assert.equal(noTts.calls.length, 1, '播报失败不影响通知本身')
  assert.ok(noTts.logs.some((line) => line.includes('找不到 termux-tts-speak')), noTts.logs.join('\n'))
})

await test('语音通知：上一条还在念时跳过新的，避免排队堆积', async () => {
  const env = makeEnv({ voice: true, throttleMs: 0 }, { ttsSlow: true })
  env.notifier.onQuestion({ questions: [{ id: 'q1', question: 'q1' }] }, () => 'A')
  await tick()
  assert.equal(env.voices.length, 1, '第一条开始念')
  env.notifier.onQuestion({ questions: [{ id: 'q2', question: 'q2' }] }, () => 'A')
  await tick()
  assert.equal(env.voices.length, 1, '上一条还在念，第二条应被跳过而不是排队')
  assert.equal(env.calls.length, 2, '但通知照发')
  env.releaseTts()
  await tick()
  env.notifier.onQuestion({ questions: [{ id: 'q3', question: 'q3' }] }, () => 'A')
  await tick()
  assert.equal(env.voices.length, 2, '上一条念完后可以再念')
})

await test('语音通知：命令缺失时直接跳过并告警', async () => {
  const env = makeEnv({ voice: true, throttleMs: 0 }, { ttsFound: false })
  env.notifier.onQuestion({ questions: [{ id: 'q1', question: 'q1' }] }, () => 'A')
  await tick()
  assert.equal(env.voices.length, 0, 'tts 命令找不到时压根不该调用')
  assert.equal(env.calls.length, 1, '通知照常发出')
  assert.ok(env.logs.some((line) => line.includes('找不到 termux-tts-speak')), env.logs.join('\n'))
})

await test('语音通知：引擎卡住连续失败到阈值后就停用播报，不再反复挂进程', async () => {
  const env = makeEnv({ voice: true, throttleMs: 0, disableAfterFailures: 2 }, { ttsFails: true })
  for (const id of ['q1', 'q2', 'q3', 'q4']) {
    env.notifier.onQuestion({ questions: [{ id, question: id }] }, () => 'A')
    await tick()
  }
  assert.equal(env.voices.length, 2, '第 3 次起不再尝试播报')
  assert.equal(env.calls.length, 4, '通知一直照常发出')
  assert.ok(env.logs.some((line) => line.includes('已停止播报')), env.logs.join('\n'))
  assert.ok(env.logs.some((line) => line.includes('TTS 引擎卡住了')), env.logs.join('\n'))
})

await test('语音通知：语速/音调显式传给 Termux:API（否则它会把手机设置强制成 1.0）', async () => {
  const env = makeEnv({ voice: true, voiceRate: 1.4, voicePitch: 0.9 })
  env.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  const args = env.voices[0].args
  assert.equal(args[args.indexOf('-r') + 1], '1.4')
  assert.equal(args[args.indexOf('-p') + 1], '0.9')

  // 越界值在宿主侧是「回退默认」（与其它数值字段一致），收敛发生在设置页表单里
  const outOfRange = makeEnv({ voice: true, voiceRate: 99, voicePitch: 0.01 })
  outOfRange.notifier.onQuestion({ questions: [{ id: 'q', question: 'q' }] }, () => 'A')
  await tick()
  const cargs = outOfRange.voices[0].args
  assert.equal(cargs[cargs.indexOf('-r') + 1], '1', '超上限回退默认')
  assert.equal(cargs[cargs.indexOf('-p') + 1], '1', '超下限回退默认')
})

await test('语音通知：超时按文本长度自适应（TTS 会阻塞到播完）', async () => {
  const env = makeEnv({ voice: true, voiceTemplate: '{content}', execTimeoutMs: 8000 })
  env.notifier.onQuestion({ questions: [{ id: 'q', question: 'x'.repeat(200) }] }, () => 'A')
  await tick()
  const spoken = env.voices[0].args[env.voices[0].args.length - 1]
  assert.ok(env.voices[0].opts.timeoutMs > 8000, `TTS 超时应比通知超时更宽松，实际 ${env.voices[0].opts.timeoutMs}`)
  assert.equal(env.voices[0].opts.timeoutMs, Math.min(90000, Math.max(20000, spoken.length * 600)))
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
  assert.equal(flagValue(calls[0].args, '--title'), '✅ 任务完成')
  assert.equal(flagValue(calls[0].args, '--id'), 'dsh-turn', '结果类沿用固定 tag（覆盖上一条）')
  assert.equal(flagValue(calls[0].args, '--priority'), 'default', '结果类不弹横幅、不打断')
  const lines = flagValue(calls[0].args, '--content').split('\n')
  assert.equal(lines[0], '本轮对话已结束')
  assert.equal(lines[1], '修复登录超时')
  assert.equal(lines[2], '已经修好了。 改动在 auth.ts。', '摘要应折叠换行')
})

await test('结果：耗时超过长任务阈值就用「长任务完成」', async () => {
  const { notifier, calls, setClock } = makeEnv({ longTurnMs: 30000 })
  setClock(0)
  notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  setClock(90_000)
  notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  assert.equal(flagValue(calls[0].args, '--title'), '✅ 长任务完成')
  assert.match(flagValue(calls[0].args, '--content'), /^耗时 1m30s/)
})

await test('结果：中止/被阻止/达到上限各有对应说法', async () => {
  for (const [kind, title, speech] of [
    ['aborted', '⏹ 已中止', '任务已中止'],
    ['blocked', '⏹ 已阻止', '任务已阻止'],
    ['max-tokens', '⚠️ 达到上限', '任务达到上限'],
  ]) {
    const { notifier, calls, voices } = makeEnv({ voice: true, throttleMs: 0 })
    notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
    await tick()
    assert.equal(flagValue(calls[0].args, '--title'), title, kind)
    assert.equal(voices[0].args[voices[0].args.length - 1], speech, kind)
  }
})

await test('结果：error 轮次标题不同且带错误信息', async () => {
  const { notifier, calls } = makeEnv()
  notifier.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'rate limited' } } } })
  await tick()
  assert.equal(flagValue(calls[0].args, '--title'), '❌ 出错了')
  assert.equal(flagValue(calls[0].args, '--content'), 'rate limited', '正文直接放错误摘要')
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

  // throttleMs=0：这条用例连发两次同样的通知来对比配置，别被去重拦掉
  apply(ctx, { dryRun: true, throttleMs: 0 })
  assert.equal(installs.length, 1, '必须注册一个设置命名空间')
  const [owner, ns, schema, entry, settingsHooks] = installs[0]
  assert.equal(owner, ctx)
  assert.equal(ns, SETTINGS_NAMESPACE)
  assert.equal(schema, SettingsSchema)
  assert.deepEqual(entry, { dryRun: true, throttleMs: 0 }, '组合配置作为 base 传入')

  // 设置服务解析出新的用户配置
  settingsHooks.setSource(() => ({ ...DEFAULTS, dryRun: true, voiceTemplate: '设置页改过：{speech}' }))
  hooks.get('user-questions/request')[0]({ questions: [{ id: 'q', question: '要选吗' }] }, () => 'NEXT')
  await tick()
  assert.ok(logs.some((line) => line.includes('语音「设置页改过：需要你选择，要选吗」')), `改动没有生效：\n${logs.join('\n')}`)

  // 服务消失时回退组合配置
  settingsHooks.setSource(() => ({ ...DEFAULTS, dryRun: true, throttleMs: 0 }))
  settingsHooks.onChange()
  logs.length = 0
  hooks.get('user-questions/request')[0]({ questions: [{ id: 'q', question: '要选吗' }] }, () => 'NEXT')
  await tick()
  assert.ok(logs.some((line) => line.includes('语音「需要你选择，要选吗」')), `没有回退组合配置：\n${logs.join('\n')}`)
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
  assert.ok(logs.some((line) => line.includes('✅ 任务完成')), logs.join('\n'))
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
  for (const key of ['config', 'command', 'app', 'tap', 'vibrate', 'headsUp', 'runtime']) {
    assert.equal(stepOf(result, key)?.status, 'ok', `${key} 应为 ok：${JSON.stringify(stepOf(result, key))}`)
  }
  assert.match(stepOf(result, 'command').detail, /termux-notification/)
  assert.match(stepOf(result, 'tap').detail, /termux-open-url/)
  assert.equal(stepOf(result, 'voice').status, 'skip', '语音默认关闭')
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
  assert.equal(stepOf(off, 'vibrate').status, 'skip', '关闭是合法状态，不该拉响总评')
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

await test('环境检测：悬浮通知与语音通知各自给出可执行的提示', async () => {
  const headsOk = await makeEnv().notifier.runEnvironmentCheck()
  assert.equal(stepOf(headsOk, 'headsUp').status, 'ok')
  assert.match(stepOf(headsOk, 'headsUp').detail, /HIGH/)

  const headsOff = await makeEnv({ headsUp: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(headsOff, 'headsUp').status, 'skip')

  const headsNoHelper = await makeEnv({}, { channelHelperFound: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(headsNoHelper, 'headsUp').status, 'fail')
  assert.match(stepOf(headsNoHelper, 'headsUp').hint, /pkg install termux-api/)

  assert.equal(stepOf(headsOk, 'voice').status, 'skip', '默认关闭')
  const voiceOn = await makeEnv({ voice: true }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(voiceOn, 'voice').status, 'ok')
  assert.match(stepOf(voiceOn, 'voice').detail, /将念出/)

  const voiceNoTts = await makeEnv({ voice: true }, { ttsFound: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(voiceNoTts, 'voice').status, 'fail')

  const voiceNoEngine = await makeEnv({ voice: true }, { enginesMissing: true }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(voiceNoEngine, 'voice').status, 'warn')
  assert.match(stepOf(voiceNoEngine, 'voice').hint, /文字转语音/)
})

await test('环境检测：试发会一并走通悬浮通道与语音播报', async () => {
  const env = makeEnv({ voice: true })
  const result = await env.notifier.runEnvironmentCheck({ sendTest: true })
  assert.equal(stepOf(result, 'send').status, 'ok')
  assert.equal(env.channels.length, 1, '试发也应先建通道')
  assert.equal(flagValue(env.calls[0].args, '--channel'), CHANNEL_ID)
  assert.equal(env.voices.length, 1, '试发也应播报')
  assert.equal(env.vibrates.length >= 1, true, '试发也应振动')
})

await test('环境检测：清空旧通知一项说明策略，并在请求时真的执行', async () => {
  const on = await makeEnv().notifier.runEnvironmentCheck()
  assert.equal(stepOf(on, 'clear').status, 'ok')
  assert.match(stepOf(on, 'clear').detail, /新一轮开始、或你回答完提问\/审批/)

  const off = await makeEnv({ clearStale: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(off, 'clear').status, 'skip')
  assert.match(stepOf(off, 'clear').detail, /已关闭/)

  const noBin = await makeEnv({}, { removeFound: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(noBin, 'clear').status, 'warn')
  assert.match(stepOf(noBin, 'clear').hint, /pkg install termux-api/)

  // clear:true → 真撤一条并报条数
  const env = makeEnv({ throttleMs: 0 })
  env.notifier.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick()
  const cleared = await env.notifier.runEnvironmentCheck({ clear: true })
  assert.equal(stepOf(cleared, 'clear').status, 'ok')
  assert.match(stepOf(cleared, 'clear').detail, /已撤销 1 条/)
  assert.equal(env.removals.length, 1)

  // 没有可撤的 → skip
  const nothing = await makeEnv().notifier.runEnvironmentCheck({ clear: true })
  assert.equal(stepOf(nothing, 'clear').status, 'skip')
  assert.match(stepOf(nothing, 'clear').detail, /没有本插件发过的通知/)
})

await test('环境检测：dry-run / 关闭都会如实说明', async () => {
  const dry = await makeEnv({ dryRun: true }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(dry, 'config').status, 'warn')
  assert.match(stepOf(dry, 'config').detail, /dry-run/)

  const off = await makeEnv({ enabled: false }).notifier.runEnvironmentCheck()
  assert.equal(stepOf(off, 'config').status, 'warn')

  const ok = await makeEnv().notifier.runEnvironmentCheck()
  assert.equal(stepOf(ok, 'config').status, 'ok')
  assert.equal(stepOf(ok, 'config').detail, '已启用', '不再展示通道名（只剩 Termux API 一条路）')
})

await test('环境检测：试发成功会复位“已停用”，失败则报出来', async () => {
  const ok = makeEnv()
  ok.notifier.state.degraded = true
  const result = await ok.notifier.runEnvironmentCheck({ sendTest: true })
  assert.equal(stepOf(result, 'send').status, 'ok')
  assert.equal(result.sent, true)
  assert.equal(result.summary, '通道可用，通知已经发出')
  assert.equal(ok.notifier.state.degraded, false, '试发成功应解除停用（装好 APK 后不必重启）')
  assert.ok(flagValue(ok.calls[0].args, '--id').startsWith('dsh-test-'), '测试通知每次用全新 tag，保证弹横幅')
  assert.equal(flagValue(ok.calls[0].args, '--title'), '🔔 测试通知')

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

  // clear 动作：响应里应带上清空那一项
  const clearRes = makeRes()
  await routes[0].handler(makeReq({ body: JSON.stringify({ clear: true }) }), clearRes)
  assert.equal(clearRes.statusCode, 200)
  const clearPayload = JSON.parse(clearRes.body)
  assert.ok(clearPayload.steps.some((step) => step.key === 'clear'), JSON.stringify(clearPayload.steps))
})

console.log(`\n${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  for (const { title, error } of failures) console.error(`\n[${title}]\n${error?.stack ?? error}`)
  process.exit(1)
}
