/**
 * dsh-termux-notify 客户端（设置里的独立标签页）测试。
 *
 *   node test/client.mjs
 *
 * 没有浏览器，所以用 `node:vm` 把 client/client.js 当成浏览器脚本加载：
 * 提供假的 `window.__ModuleLoader__`、假的 `react`（只实现用到的 Hook）、假的
 * ui-primitives 组件和假的 `fetch`。这样能真实验证四件事：
 *   1. bundle 能被 load、apply 的接线正确（绑定命名空间 + 注册 settings.section）；
 *   2. 设置页能渲染出全部字段（字段表与宿主 DEFAULTS 双向一致）；
 *   3. 开关/下拉/恢复默认的写入路径确实调用了 settingsScope；
 *   4. 「检测环境 / 发一条测试通知」确实 POST 到检测路由，结果能渲染出提示。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { DEFAULTS, SETTINGS_NAMESPACE } from '../lib/index.js'

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/** 只实现用到的 Hook 的迷你 React。 */
function createFakeReact() {
  return {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useCallback(fn) {
      return fn
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

/** 具名桩组件，方便在渲染树里按名字找。 */
function makeStub(componentName) {
  const Stub = (props) => ({ type: componentName, props })
  Object.defineProperty(Stub, 'name', { value: componentName })
  return Stub
}

function makePrimitives(overrides = {}) {
  return {
    Button: makeStub('Button'),
    Input: makeStub('Input'),
    Menu: makeStub('Menu'),
    Switch: makeStub('Switch'),
    ...overrides,
  }
}

/** 在 vm 里加载 bundle，返回模块导出与记录到的 fetch 调用。 */
function loadBundle(globals = {}) {
  const loaded = []
  const fetchCalls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (record) => loaded.push(record) } },
    console,
    fetch: (url, init) => {
      fetchCalls.push({ url, init })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          sent: false,
          summary: '环境就绪',
          steps: [{ key: 'command', title: 'termux-notification 命令', status: 'ok' }],
        }),
      })
    },
    ...globals,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client/client.js' })
  assert.equal(loaded.length, 1, 'bundle 必须调用一次 __ModuleLoader__.load')
  const record = loaded[0]
  const primitives = globals.__primitives ?? makePrimitives()
  const fakeRequire = (id) => {
    if (id === 'react') return createFakeReact()
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`意外的 require: ${id}`)
  }
  return { record, mod: record.factory(fakeRequire), fetchCalls }
}

/** 假的 settingsScope。 */
function makeScope(snapshot) {
  const sets = []
  const unsets = []
  return {
    sets,
    unsets,
    set(field, value) { sets.push([field, value]); return Promise.resolve() },
    unset(field) { unsets.push(field); return Promise.resolve() },
    subscribe() { return () => {} },
    getSnapshot() { return snapshot },
  }
}

/** 假的浏览器侧 ctx。 */
function makeCtx(scope) {
  const bound = []
  const injected = []
  const registered = []
  return {
    bound,
    injected,
    registered,
    settingsScope: { bind: (spec) => { bound.push(spec); return scope } },
    slots: {
      inject(key, callback) {
        injected.push(key)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
}

const readySnapshot = (user = {}) => ({
  status: 'ready',
  value: { ...DEFAULTS },
  base: { ...DEFAULTS },
  user,
  writable: true,
  mode: 'host',
})

/**
 * 递归展开渲染树：函数组件会被真正调用（桩组件返回 `{type:'Name', props}` 就停），
 * 因此 Row/DraftInput/Select/CheckPanel 内部的文本也能被收集到。
 */
function walk(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.elements.push(node)
  if (typeof node.type === 'function') {
    walk(node.type(node.props), out)
    return out
  }
  walk(node.props?.children, out)
  return out
}

const collect = (node) => walk(node, { elements: [], texts: [] })

console.log('dsh-termux-notify 客户端测试（假浏览器 + 假 React）\n')

const { record, mod, fetchCalls } = loadBundle()

await test('bundle 自报的身份与接口正确', () => {
  assert.equal(record.id, 'dsh-termux-notify')
  assert.equal(mod.name, 'dsh-termux-notify')
  assert.deepEqual([...mod.inject], ['slots', 'settingsScope'])
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.__internals, '需要 __internals 供测试读取字段表与纯组件')
})

await test('字段表与宿主 DEFAULTS 双向一致（防漂移）', () => {
  const clientKeys = [...mod.__internals.FIELDS.map((field) => field.key)]
  assert.deepEqual(clientKeys.sort(), [...Object.keys(DEFAULTS)].sort(),
    '每个宿主配置字段都必须有对应控件，且不得有宿主不认识的字段')
  assert.equal(new Set(clientKeys).size, clientKeys.length, '字段不得重复')
  const kinds = new Set(['switch', 'text', 'number', 'select'])
  for (const field of mod.__internals.FIELDS) {
    assert.ok(kinds.has(field.type), `${field.key} 的 type 非法：${field.type}`)
    assert.ok(typeof field.label === 'string' && field.label.length > 0, `${field.key} 缺少 label`)
    if (field.type === 'select') assert.ok(Array.isArray(field.options) && field.options.length > 0, `${field.key} 缺少选项`)
  }
})

await test('parseDraft：数字越界收敛、振动支持 pattern、非法输入忽略', () => {
  const { FIELDS, parseDraft } = mod.__internals
  const byKey = Object.fromEntries(FIELDS.map((field) => [field.key, field]))
  assert.equal(parseDraft(byKey.snippetChars, '9999'), 2000, '超过 max 收敛到 max')
  assert.equal(parseDraft(byKey.snippetChars, '1'), 20, '低于 min 收敛到 min')
  assert.equal(parseDraft(byKey.snippetChars, 'abc'), undefined, '非数字忽略')
  assert.equal(parseDraft(byKey.vibrateMs, '200'), 200, '纯数字转 number')
  assert.equal(parseDraft(byKey.vibrateMs, '500,1000,200'), '500,1000,200', 'pattern 保持字符串')
  assert.equal(parseDraft(byKey.vibrateMs, ''), 0, '空串视为不振动')
  assert.equal(parseDraft(byKey.vibrateMs, 'nope'), undefined, '非法 pattern 忽略')
})

await test('apply：绑定命名空间并注册独立的 settings.section（不是插件页卡片）', () => {
  const ctx = makeCtx(makeScope(readySnapshot()))
  mod.apply(ctx)

  assert.deepEqual(ctx.bound.map((spec) => spec.namespace), [SETTINGS_NAMESPACE], '必须绑定宿主注册的同一个命名空间')
  assert.deepEqual([...ctx.injected], ['settings.section'], '必须注册成设置里的独立分区')
  assert.equal(ctx.registered.length, 1)
  const options = ctx.registered[0].options
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, mod.__internals.SECTION_ID)
  assert.equal(options.order, mod.__internals.SECTION_ORDER)
  assert.equal(options.label(), mod.__internals.SECTION_LABEL)
  assert.equal(typeof ctx.registered[0].component, 'function')
})

await test('设置页渲染：每个字段都出现，且没有塞进插件页的槽', () => {
  const ctx = makeCtx(makeScope(readySnapshot()))
  mod.apply(ctx)
  const { texts, elements } = collect(ctx.registered[0].component())

  const switchLabels = elements.filter((node) => node.type?.name === 'Switch').map((node) => node.props.label)
  for (const field of mod.__internals.FIELDS) {
    const rendered = texts.includes(field.label) || switchLabels.includes(field.label)
    assert.ok(rendered, `字段「${field.label}」没有渲染出来`)
  }
  assert.ok(texts.includes('Termux 通知'), `缺少页面标题：${texts.slice(0, 12).join(' / ')}`)
  assert.ok(texts.includes('环境检测'), '缺少环境检测面板')
  assert.ok(!ctx.injected.includes('settings.plugin.item'), '不应再注册到插件页')
})

await test('设置页渲染：开关改动立即写入 settingsScope', async () => {
  const scope = makeScope(readySnapshot())
  const ctx = makeCtx(scope)
  mod.apply(ctx)
  const { elements } = collect(ctx.registered[0].component())

  const master = elements.find((node) => node.type?.name === 'Switch' && node.props.label === '总开关')
  assert.ok(master, '找不到「总开关」')
  assert.equal(master.props.checked, true)
  master.props.onChange(false)
  await tick()
  assert.deepEqual(scope.sets, [['enabled', false]], '开关应调用 scope.set')
})

await test('设置页渲染：下拉选项来自字段表', () => {
  const scope = makeScope(readySnapshot())
  const ctx = makeCtx(scope)
  mod.apply(ctx)
  const { elements } = collect(ctx.registered[0].component())

  const select = elements.find((node) => node.type?.name === 'Menu')
  assert.ok(select, '找不到下拉控件')
  const priorityOptions = mod.__internals.FIELDS.find((field) => field.key === 'priority').options
  assert.equal(select.props.items.length, priorityOptions.length)
  assert.equal(select.props.selectedId, DEFAULTS.priority)
  select.props.onSelect('low')
  assert.deepEqual(scope.sets, [['priority', 'low']])
})

await test('设置页渲染：文本框控件按字段类型取参数', () => {
  const ctx = makeCtx(makeScope(readySnapshot()))
  mod.apply(ctx)
  const { elements } = collect(ctx.registered[0].component())

  const input = elements.find((node) => node.type?.name === 'Input' && node.props.min === 20 && node.props.max === 2000)
  assert.ok(input, '找不到「摘要长度」输入框')
  assert.equal(input.props.type, 'number')
  assert.equal(input.props.value, String(DEFAULTS.snippetChars))
  const text = elements.find((node) => node.type?.name === 'Input' && node.props.value === String(DEFAULTS.titlePrefix))
  assert.ok(text, '找不到「标题前缀」输入框')
  assert.equal(text.props.type, 'text')
})

await test('设置页渲染：「全部恢复默认」只清除被覆盖的字段', async () => {
  const scope = makeScope(readySnapshot({ titlePrefix: 'X', sound: false }))
  const ctx = makeCtx(scope)
  mod.apply(ctx)
  const { elements, texts } = collect(ctx.registered[0].component())

  assert.ok(texts.includes('2 项已覆盖'), `应显示覆盖计数：${texts.join(' / ')}`)
  const resetAll = elements.find((node) => node.type?.name === 'Button' && node.props.children === '全部恢复默认')
  assert.ok(resetAll, '找不到「全部恢复默认」按钮')
  assert.equal(resetAll.props.disabled, false)
  resetAll.props.onClick()
  await tick()
  assert.deepEqual([...scope.unsets].sort(), ['sound', 'titlePrefix'], '只清除 user 层里存在的字段')
})

await test('检测面板：两个按钮分别 POST sendTest=false / true', async () => {
  const ctx = makeCtx(makeScope(readySnapshot()))
  mod.apply(ctx)
  const { elements } = collect(ctx.registered[0].component())

  const checkButton = elements.find((node) => node.type?.name === 'Button' && node.props.children === '检测环境')
  const sendButton = elements.find((node) => node.type?.name === 'Button' && node.props.children === '发一条测试通知')
  assert.ok(checkButton, '找不到「检测环境」按钮')
  assert.ok(sendButton, '找不到「发一条测试通知」按钮')

  checkButton.props.onClick()
  await tick()
  await tick()
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, mod.__internals.CHECK_PATH)
  assert.equal(fetchCalls[0].init.method, 'POST')
  assert.equal(fetchCalls[0].init.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { sendTest: false })

  sendButton.props.onClick()
  await tick()
  await tick()
  assert.equal(fetchCalls.length, 2)
  assert.deepEqual(JSON.parse(fetchCalls[1].init.body), { sendTest: true })
})

await test('检测结果渲染：每步的状态/标题/详情/修复提示都出得来', () => {
  const result = {
    ok: false,
    sent: false,
    summary: '环境还不完整 —— 按下面的提示修一下',
    steps: [
      { key: 'command', title: 'termux-notification 命令', status: 'ok', detail: '/usr/bin/termux-notification' },
      { key: 'app', title: 'Termux:API 应用', status: 'fail', detail: '没有找到 com.termux.api 包', hint: '从 F-Droid 安装 Termux:API 应用' },
      { key: 'runtime', title: '插件运行状态', status: 'warn', detail: '本次运行已停用通知' },
    ],
  }
  const { texts } = collect(mod.__internals.CheckResultList({ result, error: '' }))
  assert.ok(texts.includes('环境还不完整 —— 按下面的提示修一下'), '缺少总评')
  assert.ok(texts.includes('termux-notification 命令'), '缺少步骤标题')
  assert.ok(texts.includes('/usr/bin/termux-notification'), '缺少步骤详情')
  assert.ok(texts.includes('→ 从 F-Droid 安装 Termux:API 应用'), '缺少修复提示')
  assert.ok(texts.includes('✓') && texts.includes('✗') && texts.includes('!'), '缺少状态符号')
})

await test('检测结果渲染：没有结果时不渲染任何东西', () => {
  assert.equal(mod.__internals.CheckResultList({ result: null, error: '' }), null)
})

await test('设置页渲染：不可写/不可用状态下不报错且禁用控件', () => {
  const unavailable = makeScope({ status: 'unavailable' })
  const ctxA = makeCtx(unavailable)
  mod.apply(ctxA)
  const textsA = collect(ctxA.registered[0].component()).texts.join(' ')
  assert.ok(textsA.includes('没有暴露'), `应提示命名空间不可用：${textsA}`)

  const readonly = makeScope({ status: 'ready', value: { ...DEFAULTS }, base: {}, user: {}, writable: false, mode: 'memory' })
  const ctxB = makeCtx(readonly)
  mod.apply(ctxB)
  const { elements } = collect(ctxB.registered[0].component())
  const master = elements.find((node) => node.type?.name === 'Switch' && node.props.label === '总开关')
  assert.equal(master.props.disabled, true, '不可写时必须禁用控件')
})

await test('apply：宿主 ui-primitives 缺组件时安全退出（不注册半个页面）', () => {
  const broken = loadBundle({ __primitives: makePrimitives({ Switch: undefined }) })
  const ctx = makeCtx(makeScope(readySnapshot()))
  broken.mod.apply(ctx)
  assert.equal(ctx.registered.length, 0, '缺组件时不应注册设置页')
  assert.equal(ctx.injected.length, 0)
})

console.log(`\n${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  for (const { title, error } of failures) console.error(`\n[${title}]\n${error?.stack ?? error}`)
  process.exit(1)
}
