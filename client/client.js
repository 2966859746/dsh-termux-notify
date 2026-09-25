/**
 * dsh-termux-notify — 浏览器半侧（设置里的独立标签页）。
 *
 * 这是手写的客户端 bundle，格式与 DSH 自带的客户端插件完全一致：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 里用宿主提供的
 * CommonJS 风格 `require` 取用「基座」共享模块（react、ui-primitives 等）。
 * 因此**不需要任何构建步骤**（tsdown/vite），改完直接刷新页面即可。
 *
 * 它做三件事：
 *  1. `ctx.settingsScope.bind({ namespace: 'termux-notify' })` 绑定宿主注册的设置命名空间；
 *  2. 往 `settings.section` 注册**一个独立的设置页**（设置左侧导航里的「通知」），
 *     而不是塞进「插件」分区里的卡片；
 *  3. 页内提供「检测环境 / 发一条测试通知」按钮，打宿主的
 *     `POST /dsh-termux-notify/check`，把每一步的结果和修复提示显示出来。
 *
 * 写入策略：开关/下拉即时生效（scope.set），文本框在失焦或回车时提交。
 * scope 的每次写入自动带最新 revision 围栏，不需要手写 Save/冲突处理。
 */
window.__ModuleLoader__.load({
  id: 'dsh-termux-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Input, Menu, Switch } = primitives
    const h = React.createElement

    const name = 'dsh-termux-notify'
    /** 必须与宿主 lib/index.js 的 SETTINGS_NAMESPACE 一致。 */
    const NS = 'termux-notify'
    /** 必须与宿主 lib/index.js 的 CHECK_ROUTE_PATH 一致。 */
    const CHECK_PATH = '/dsh-termux-notify/check'
    /** 设置导航里的分区标识与位置（内置：general 0 / models 10 / plugins 15）。 */
    const SECTION_ID = 'notify'
    const SECTION_ORDER = 20
    const SECTION_LABEL = 'Termux 通知'
    const TITLE = 'Termux 通知'

    const PRIORITIES = ['high', 'low', 'max', 'min', 'default']
    const BACKENDS = ['termux', 'command']
    const VIBRATE_VIA = ['termux-api', 'notification']

    /**
     * 卡片字段表。`key` 必须是宿主 DEFAULTS 里的字段名
     * （test/run.mjs 有一条防漂移断言：每个宿主字段都必须在这里出现）。
     * type: switch | text | number | select
     */
    const FIELDS = [
      { key: 'enabled', group: '触发时机', label: '总开关', type: 'switch', hint: '关掉后完全不发通知' },
      { key: 'notifyOnQuestion', label: '需要你选择时', type: 'switch', hint: 'ask_user_question、计划审阅等等待人类回答的请求' },
      { key: 'notifyOnApproval', label: '需要授权时', type: 'switch', hint: '敏感工具的一次性审批请求' },
      { key: 'notifyOnTurnEnd', label: '结果出现时', type: 'switch', hint: '一轮结束（turn/end）' },
      { key: 'notifyChildSessions', label: '子 agent 轮次也通知', type: 'switch', hint: '默认关，避免刷屏' },
      { key: 'minTurnDurationMs', label: '最短耗时（毫秒）', type: 'number', min: 0, step: 1000, hint: '耗时更短的轮次不通知；0 = 每轮都通知' },

      { key: 'titlePrefix', group: '通知内容', label: '标题前缀', type: 'text', placeholder: 'DSH' },
      { key: 'includeSnippet', label: '附带结果摘要', type: 'switch', hint: '把模型最后一段文本放进通知正文' },
      { key: 'snippetChars', label: '摘要长度（字符）', type: 'number', min: 20, max: 2000, step: 20 },

      { key: 'priority', group: '通知外观', label: '优先级', type: 'select', options: PRIORITIES },
      { key: 'sound', label: '提示音', type: 'switch' },
      { key: 'vibrateMs', label: '振动', type: 'text', hint: '默认 1000（1 秒）；0 = 不振动；也可写 500,1000,200 这样的 pattern', coerce: 'vibrate' },
      { key: 'vibrateVia', label: '振动方式', type: 'select', options: VIBRATE_VIA, hint: 'termux-api = 调 termux-vibrate（推荐，不受通知渠道设置影响）；notification = 用通知自带的 --vibrate' },
      { key: 'vibrateForce', label: '静音也振动', type: 'switch', hint: '对应 termux-vibrate -f：系统静音/仅振动模式下也振' },
      { key: 'tapUrl', label: '点击通知打开', type: 'text', hint: '默认用系统浏览器打开 DSH 页面；留空则改为打开 Termux 应用', wide: true },
      { key: 'group', label: '通知分组', type: 'text', hint: '同组通知会折叠在一起' },
      { key: 'notificationId', label: '通知 id 前缀', type: 'text', hint: '同类通知用同一个 id 覆盖上一条' },
      { key: 'throttleMs', label: '去重窗口（毫秒）', type: 'number', min: 0, step: 100, hint: '同内容在该窗口内只发一次' },

      { key: 'backend', group: '通道', label: '通道', type: 'select', options: BACKENDS, hint: 'termux = termux-notification；command = 自定义命令' },
      { key: 'command', label: '自定义命令模板', type: 'text', hint: '支持 {title} {content} {tag}，自动 shell 转义', wide: true },
      { key: 'dryRun', label: '只写日志（dry-run）', type: 'switch', hint: '不真发通知，用来验证接线' },
      { key: 'appProbe', label: '启动探测 Termux:API 应用', type: 'switch', hint: '缺失时直接停用，避免每次通知都留下挂起的进程' },
      { key: 'execTimeoutMs', label: '发送超时（毫秒）', type: 'number', min: 500, max: 120000, step: 500 },
      { key: 'disableAfterFailures', label: '连续失败几次后停用', type: 'number', min: 0, max: 100, step: 1 },
    ]

    const COLOR = {
      primary: 'var(--dsw-alias-label-primary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      danger: 'var(--dsw-alias-label-error, #d64545)',
      success: 'var(--dsw-alias-state-business-primary, #2f9e44)',
      warning: 'var(--dsw-alias-label-warning, #e8590c)',
    }

    /** 检测结果每行的状态样式。 */
    const STATUS = {
      ok: { glyph: '✓', color: COLOR.success },
      fail: { glyph: '✗', color: COLOR.danger },
      warn: { glyph: '!', color: COLOR.warning },
      skip: { glyph: '–', color: COLOR.tertiary },
    }

    const PAGE_STYLE = { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12, color: COLOR.primary }
    const HEADING_STYLE = { margin: 0, fontSize: 18, fontWeight: 600 }
    const INTRO_STYLE = { margin: 0, color: COLOR.tertiary, fontSize: 13, lineHeight: '20px' }
    const PANEL_STYLE = { border: `1px solid ${COLOR.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }
    const PANEL_TITLE_STYLE = { fontSize: 13, fontWeight: 600, margin: 0 }
    const GROUP_STYLE = { color: COLOR.tertiary, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', margin: '10px 0 2px' }
    const ROW_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderTop: `1px solid ${COLOR.border}` }
    const LABEL_STYLE = { color: COLOR.primary, fontSize: 13, lineHeight: '18px' }
    const HINT_STYLE = { color: COLOR.tertiary, fontSize: 11, lineHeight: '16px', marginTop: 2 }
    const BADGE_STYLE = { color: COLOR.tertiary, border: `1px solid ${COLOR.border}`, borderRadius: 4, fontSize: 10, padding: '0 4px', marginLeft: 6, verticalAlign: 'middle' }
    const NOTE_STYLE = { color: COLOR.tertiary, fontSize: 12, margin: 0 }
    const ERROR_STYLE = { color: COLOR.danger, fontSize: 12, margin: 0 }
    const STEP_DETAIL_STYLE = { color: COLOR.tertiary, fontSize: 11, marginTop: 2, wordBreak: 'break-all' }
    const BUTTONS_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }

    /** 订阅 scope 快照（getSnapshot 在变更之间是稳定引用，满足 useSyncExternalStore 要求）。 */
    function useScopeSnapshot(scope) {
      const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope])
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /** 把输入框文本解析成要写入的 JSON 值；返回 undefined 表示「这个输入不合法，忽略」。 */
    function parseDraft(field, raw) {
      const text = String(raw ?? '').trim()
      if (field.coerce === 'vibrate') {
        if (text === '') return 0
        if (/^\d+$/.test(text)) return Number(text)
        if (/^\d+(,\d+)+$/.test(text)) return text
        return undefined
      }
      if (field.type === 'number') {
        if (text === '') return undefined
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) return undefined
        if (field.min !== undefined && parsed < field.min) return field.min
        if (field.max !== undefined && parsed > field.max) return field.max
        return parsed
      }
      return String(raw ?? '')
    }

    /** 显示用文本。 */
    function display(field, value) {
      if (value === undefined || value === null) return ''
      return String(value)
    }

    /** 一条设置的说明 + 控件行。 */
    function Row({ field, value, overridden, disabled, onReset, children }) {
      return h('div', { style: ROW_STYLE }, [
        h('div', { key: 'label', style: { minWidth: 0, flex: '1 1 auto' } }, [
          h('div', { key: 'text', style: LABEL_STYLE }, [
            field.label,
            overridden ? h('span', { key: 'badge', style: BADGE_STYLE }, '已覆盖') : null,
          ]),
          field.hint ? h('div', { key: 'hint', style: HINT_STYLE }, field.hint) : null,
        ]),
        h('div', { key: 'control', style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6 } }, [
          children,
          overridden && onReset
            ? h(Button, { key: 'reset', size: 'sm', variant: 'ghost', disabled, title: '恢复部署默认值', onClick: onReset }, '默认')
            : null,
        ]),
      ])
    }

    /**
     * 文本/数字输入：本地暂存草稿，失焦或回车时提交。
     * 外部值变化（另开一个页面改了、或服务端拒绝后的恢复读取）会重新灌入草稿。
     */
    function DraftInput({ field, value, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(() => display(field, value))
      const [editing, setEditing] = React.useState(false)
      React.useEffect(() => {
        if (!editing) setDraft(display(field, value))
      }, [value, editing, field])

      const commit = () => {
        const parsed = parseDraft(field, draft)
        if (parsed === undefined) {
          setDraft(display(field, value))
          return
        }
        if (parsed !== value) onCommit(parsed)
      }

      return h(Input, {
        type: field.type === 'number' ? 'number' : 'text',
        value: draft,
        disabled,
        placeholder: field.placeholder,
        min: field.min,
        max: field.max,
        step: field.step,
        style: { width: field.wide ? 280 : 160, fontSize: 12 },
        onFocus: () => setEditing(true),
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => { setEditing(false); commit() },
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') { setDraft(display(field, value)); event.currentTarget.blur() }
        },
      })
    }

    /** 下拉选择（用宿主自带的 Menu，保持视觉一致）。 */
    function Select({ field, value, disabled, onChange }) {
      const [open, setOpen] = React.useState(false)
      const current = String(value ?? field.options[0])
      return h(Menu, {
        open,
        onClose: () => setOpen(false),
        selectedId: current,
        anchor: h(Button, { size: 'sm', variant: 'outline', disabled, onClick: () => setOpen(true) }, current),
        items: field.options.map((option) => ({ id: option, label: option })),
        onSelect: (id) => {
          setOpen(false)
          if (id !== current) onChange(id)
        },
      })
    }

    /** 检测结果里的一行。 */
    function StepRow({ step }) {
      const meta = STATUS[step.status] ?? STATUS.skip
      return h('div', { style: { display: 'flex', gap: 8, padding: '6px 0', borderTop: `1px solid ${COLOR.border}` } }, [
        h('span', { key: 'glyph', style: { color: meta.color, flex: '0 0 auto', width: 12, fontWeight: 600 } }, meta.glyph),
        h('div', { key: 'body', style: { minWidth: 0, flex: '1 1 auto' } }, [
          h('div', { key: 'title', style: LABEL_STYLE }, step.title),
          step.detail ? h('div', { key: 'detail', style: STEP_DETAIL_STYLE }, step.detail) : null,
          step.hint ? h('div', { key: 'hint', style: STEP_DETAIL_STYLE }, `→ ${step.hint}`) : null,
        ]),
      ])
    }

    /** 检测结果列表（纯展示，结果由调用方传入 —— 便于单独测试）。 */
    function CheckResultList({ result, error }) {
      if (!result && !error) return null
      const steps = result && Array.isArray(result.steps) ? result.steps : []
      const summaryColor = result ? (result.ok ? COLOR.success : COLOR.danger) : COLOR.tertiary
      return h('div', { style: { display: 'flex', flexDirection: 'column' } }, [
        result
          ? h('div', { key: 'summary', style: { color: summaryColor, fontSize: 12, fontWeight: 600 } }, result.summary)
          : null,
        ...steps.map((step) => h(StepRow, { key: step.key, step })),
        error ? h('p', { key: 'error', style: ERROR_STYLE }, error) : null,
      ])
    }

    /** 环境检测面板：一个按钮 + 逐步结果 + 修复提示。 */
    function CheckPanel() {
      const [checking, setChecking] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')

      const run = (sendTest) => {
        if (checking) return
        setChecking(true)
        setError('')
        fetch(CHECK_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sendTest }),
        }).then(
          async (response) => {
            const payload = await response.json().catch(() => undefined)
            if (!response.ok || payload === undefined) throw new Error(`HTTP ${response.status}`)
            return payload
          },
        ).then(
          (payload) => { setResult(payload); setChecking(false) },
          (failure) => {
            setChecking(false)
            setResult(null)
            setError(`检测请求失败：${failure && failure.message ? failure.message : failure}`)
          },
        )
      }

      return h('section', { style: PANEL_STYLE }, [
        h('h3', { key: 'title', style: PANEL_TITLE_STYLE }, '环境检测'),
        h('p', { key: 'help', style: NOTE_STYLE }, '检测插件开关、termux-notification 命令、Termux:API 应用和点击行为；「发一条测试通知」会真的发一条，是唯一能证明通道可用的检查。'),
        h('div', { key: 'buttons', style: BUTTONS_STYLE }, [
          h(Button, { key: 'check', size: 'sm', variant: 'primary', disabled: checking, onClick: () => run(false) }, checking ? '检测中…' : '检测环境'),
          h(Button, { key: 'send', size: 'sm', variant: 'outline', disabled: checking, onClick: () => run(true) }, '发一条测试通知'),
        ]),
        h(CheckResultList, { key: 'result', result, error }),
      ])
    }

    /** 设置页本体：标题 + 环境检测 + 配置表单。 */
    function NotifySection({ scope }) {
      const snapshot = useScopeSnapshot(scope)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}
      const overriddenKeys = Object.keys(user)
      const writable = snapshot.writable !== false && snapshot.mode !== 'memory'
      const disabled = !writable || busy

      const describeError = (failure) => `保存失败：${failure && failure.message ? failure.message : failure}`

      const run = (operation) => {
        setError('')
        setBusy(true)
        Promise.resolve(operation()).then(
          () => setBusy(false),
          (failure) => { setBusy(false); setError(describeError(failure)) },
        )
      }

      const write = (key, next) => run(() => scope.set(key, next))
      const resetOne = (key) => run(() => scope.unset(key))
      const resetAll = () => run(() => overriddenKeys.reduce(
        (chain, key) => chain.then(() => scope.unset(key)),
        Promise.resolve(),
      ))

      const rows = []
      let seenGroup = null
      for (const field of FIELDS) {
        if (field.group && field.group !== seenGroup) {
          seenGroup = field.group
          rows.push(h('div', { key: `group-${field.group}`, style: GROUP_STYLE }, field.group))
        }
        const overridden = Object.prototype.hasOwnProperty.call(user, field.key)
        const current = value[field.key]
        let control
        if (field.type === 'switch') {
          control = h(Switch, {
            checked: current === true,
            disabled,
            label: field.label,
            onChange: (next) => write(field.key, next),
          })
        } else if (field.type === 'select') {
          control = h(Select, { field, value: current, disabled, onChange: (next) => write(field.key, next) })
        } else {
          control = h(DraftInput, { field, value: current, disabled, onCommit: (next) => write(field.key, next) })
        }
        rows.push(h(Row, {
          key: field.key,
          field,
          value: current,
          overridden,
          disabled,
          onReset: () => resetOne(field.key),
        }, control))
      }

      const summary = overriddenKeys.length > 0 ? `${overriddenKeys.length} 项已覆盖` : '全部使用部署默认值'

      let status = null
      if (snapshot.status === 'loading') status = h('p', { style: NOTE_STYLE }, '载入中…')
      else if (snapshot.status === 'unavailable') status = h('p', { style: NOTE_STYLE }, '此部署没有暴露 termux-notify 设置命名空间，配置暂时不可编辑。')
      else if (!writable) status = h('p', { style: NOTE_STYLE }, '当前连接下设置不可写（进程内存模式）。')

      const footer = h('div', {
        key: 'footer',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${COLOR.border}` },
      }, [
        h('span', { key: 'summary', style: NOTE_STYLE }, summary),
        h(Button, {
          key: 'reset-all',
          size: 'sm',
          variant: 'ghost',
          disabled: disabled || overriddenKeys.length === 0,
          onClick: resetAll,
        }, '全部恢复默认'),
      ])

      return h('div', { style: PAGE_STYLE }, [
        h('h2', { key: 'heading', style: HEADING_STYLE }, TITLE),
        h('p', { key: 'intro', style: INTRO_STYLE }, '需要你选择、或一轮结果出现时，通过 Termux 给手机发系统通知。点击通知会用系统浏览器打开 DSH 页面，振动走 termux-vibrate。改动立即生效。'),
        h(CheckPanel, { key: 'check' }),
        h('section', { key: 'form', style: PANEL_STYLE }, [
          ...rows,
          error ? h('p', { key: 'error', style: ERROR_STYLE }, error) : null,
          footer,
        ]),
        status,
      ])
    }

    const inject = ['slots', 'settingsScope']

    /**
     * @param ctx - 浏览器侧根上下文。
     */
    function apply(ctx) {
      const missing = ['Button', 'Input', 'Menu', 'Switch']
        .filter((component) => typeof primitives[component] !== 'function')
      if (missing.length > 0) {
        console.warn(`[${name}] 宿主的 ui-primitives 缺少 ${missing.join(', ')}，设置页已禁用`)
        return
      }
      const scope = ctx.settingsScope.bind({ namespace: NS })
      // settings.section 是「设置」外壳声明的列表槽：每个条目就是一个独立设置页。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => SECTION_LABEL,
      }, () => h(NotifySection, { scope })))
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    // 仅供 test/client.mjs 使用（纯函数、常量与纯展示组件）；宿主与客户端运行时都不读它。
    exports.__internals = { CHECK_PATH, CheckResultList, FIELDS, SECTION_ID, SECTION_LABEL, SECTION_ORDER, display, parseDraft }
    return module.exports
  },
})
