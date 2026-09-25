/**
 * dsh-termux-notify —— 在 DSH 需要你选择、或一轮结果出现时，通过 Termux 给手机发系统通知。
 *
 * 三个观测点（都是只读旁路，绝不改变原有行为）：
 *
 * 1. `user-questions/request` —— `ask_user_question` 提问、计划模式（exit_plan_mode）审阅等
 *    「需要人类回答」的请求。这是一个 Cordis waterfall；本插件 *prepend* 自己，
 *    先发通知，再 `next()` 委托给真正的回答者（Web 前端）。顺序很关键：
 *    若追加在末尾，就要等真正的回答者先交出结果（即用户已经回答完）才会被执行。
 * 2. `approval/request` —— 敏感工具/权限的一次性审批请求（`ask` 策略下）。
 *    同样是 waterfall，同样先通知再 `next()` 委托。
 * 3. `session/event` 事件流里的 `turn/end` —— 一轮结束，结果已经出现。
 *    （顺带消费 `turn/start` / `assistant/message` / `session/title` 用来算耗时和摘要。）
 *
 * 通知方式：`termux-notification`（termux-api 包 + Termux:API 应用）。
 * 之所以要「启动探测 + 硬超时」：Termux:API 应用缺失时 `termux-notification` 不会报错退出，
 * 而是一直挂起等待广播回应，所以在缺少应用的环境里必须有超时兜底并停用，否则每次通知都会留下僵尸进程。
 *
 * 设计约束：通知永远不能影响 agent 循环 —— 全部 fire-and-forget，异常只记录日志。
 *
 * @module dsh-termux-notify
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

const name = 'dsh-termux-notify'

/**
 * 设置命名空间：宿主侧用 `settings.installSection()` 注册它，
 * 客户端（client/client.js）据此在「设置 → 插件 → 插件配置」里渲染卡片。
 * 运行时改动无需重启，通知行为立即跟随。
 */
const SETTINGS_NAMESPACE = 'termux-notify'

/**
 * 悬浮通知（heads-up）用的通知通道。
 *
 * Android 8+ 上「能不能弹出横幅」由**通道重要性**决定，而不是 `--priority`。
 * Termux:API 建通道时从 intent 的 `priority` extra 取重要性，但自带的
 * `termux-notification-channel` 包装脚本**不传**这个 extra（默认 IMPORTANCE_DEFAULT，不悬浮），
 * 所以这里直接调底层的 `libexec/termux-api` 并补上 `--es priority high`。
 * 另一个坑：给 `termux-notification --channel` 传一个**不存在的通道 id，通知会被直接丢弃**，
 * 因此必须先确认通道建好，再在通知里引用它。
 */
const CHANNEL_ID = 'dsh-heads-up'
const CHANNEL_NAME = 'DSH 悬浮通知'
/** 场景用到的 emoji + 短标题，集中在这里便于对照文档。 */

/** termux-notification 的 priority 取值白名单。 */
const PRIORITIES = ['high', 'low', 'max', 'min', 'default']

/** 默认配置：全部字段都可在 profile 的 cordis.patch.yml 里覆盖。 */
const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** `user-questions/request`：模型在等你选择/回答时通知。 */
  notifyOnQuestion: true,
  /** `approval/request`：需要一次性授权时通知。 */
  notifyOnApproval: true,
  /** `turn/end`：一轮结果出现时通知。 */
  notifyOnTurnEnd: true,
  /** 子 agent（subagent）会话的轮次结束是否也通知。默认关，避免刷屏。 */
  notifyChildSessions: false,
  /** 只通知耗时 ≥ 该值（毫秒）的轮次；0 = 每轮都通知。 */
  minTurnDurationMs: 0,
  /** 结果通知里是否附带模型最后一段文本。 */
  includeSnippet: true,
  /** 摘要截断长度（字符）。 */
  snippetChars: 120,
  /** 通知 id 前缀：同类通知会覆盖上一条，不同类各占一条。 */
  notificationId: 'dsh',
  /** Android 通知分组（同组通知折叠在一起）。留空则不传。 */
  group: 'dsh',
  /** 通知优先级：high / low / max / min / default。 */
  priority: 'high',
  /** 是否带提示音。 */
  sound: true,
  /** 振动毫秒数，0 = 不振动；可写成 "500,1000,200" 这类 pattern（pattern 只能走通知渠道）。 */
  vibrateMs: 1000,
  /**
   * 振动方式：
   *  - `termux-api`（默认）：额外调 `termux-vibrate -d <ms>`，直接走系统 Vibrator，
   *    **不受通知渠道设置影响** —— 通知自带的 `--vibrate` 在 Android 8+ 上经常被渠道设置忽略，
   *    这正是「设了震动却不振」的常见原因。
   *  - `notification`：只用 `termux-notification --vibrate <pattern>`。
   */
  vibrateVia: 'termux-api',
  /** 传给 `termux-vibrate -f`：即使系统处于静音/仅振动模式也振动。 */
  vibrateForce: true,
  /**
   * 悬浮通知：用一个重要性 HIGH 的专用通道，让通知像横幅一样弹出来（heads-up），
   * 而不是安静地待在通知栏里。关掉则用 termux-notification 的默认通道。
   */
  headsUp: true,
  /**
   * 悬浮通知使用的通道 id。
   *
   * 需要换一个通道时把它改成新值（例如 `dsh-heads-up2`）即可：Android 会创建一个
   * **没有被改过设置**的全新通道，重要性 HIGH 才会真正生效。
   * 若在系统设置里把某个通道降过重要性，程序再怎么重建也改不回来（Android 以用户设置为准）。
   */
  headsUpChannel: 'dsh-heads-up',
  /** 一轮耗时达到该值就用「长任务完成」的说法（毫秒）。 */
  longTurnMs: 60000,
  /** 语音通知：额外调 `termux-tts-speak` 把通知读出来。 */
  voice: false,
  /** 播报内容模板，支持 {title} 与 {content}。默认只读标题，避免把长摘要在公共场合念出来。 */
  voiceTemplate: '{speech}',
  /** 播报语言，例如 zh / en；留空则由系统 TTS 引擎自行决定。 */
  voiceLanguage: '',
  /**
   * 播报语速 / 音调（1 = 正常）。
   *
   * 为什么要有这两项：Termux:API 每次都会 `setSpeechRate(getFloatExtra("rate", 1.0))`
   * 和 `setPitch(...)`，**不传就是 1.0** —— 也就是说它会覆盖你在系统「文字转语音」里设的语速，
   * 而那个值在 Termux 里读不到（`settings get secure tts_default_rate` 需要
   * INTERACT_ACROSS_USERS 权限）。想和手机一致，只能在这里填成同一个值。
   */
  voiceRate: 1,
  /** 播报音调（1 = 正常）。同上：Termux:API 会强制覆盖系统设置。 */
  voicePitch: 1,
  /**
   * 非空时，点击通知会执行 `termux-open-url <该地址>`（默认打开系统浏览器进入 DSH 页面）。
   * 通知只做“提醒”，具体操作回浏览器里做 —— 通知栏上的操作太容易误触。
   * 留空则恢复 termux-notification 的默认行为（点开 Termux 应用）。
   */
  tapUrl: 'http://127.0.0.1:3080/',
  /** 同一内容在该毫秒窗口内只发一次，抑制重复。0 = 不去重。 */
  throttleMs: 1500,
  /** 启动时探测 Termux:API 应用是否安装；探测到缺失就直接停用，避免挂起。 */
  appProbe: true,
  /** 连续失败多少次后，本次运行内停用通知。 */
  disableAfterFailures: 3,
  /** 单次 termux-notification 调用的硬超时（毫秒）。 */
  execTimeoutMs: 8000,
  /** 只写日志不真发通知，便于调试。 */
  dryRun: false,
}

/** 读取布尔配置：非布尔值时回退默认值。 */
function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 读取数字配置：非法或越界时回退默认值。 */
function pickNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  if (min !== undefined && n < min) return fallback
  if (max !== undefined && n > max) return fallback
  return n
}

/** 读取字符串配置：非字符串或空串时回退默认值。 */
function pickString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * 把任意来源的配置规范化成完整、可用的配置对象。
 * @param raw - profile patch 里给的原始 config。
 * @returns 带默认值与范围保护的配置。
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS }
  cfg.enabled = pickBool(source.enabled, DEFAULTS.enabled)
  cfg.notifyOnQuestion = pickBool(source.notifyOnQuestion, DEFAULTS.notifyOnQuestion)
  cfg.notifyOnApproval = pickBool(source.notifyOnApproval, DEFAULTS.notifyOnApproval)
  cfg.notifyOnTurnEnd = pickBool(source.notifyOnTurnEnd, DEFAULTS.notifyOnTurnEnd)
  cfg.notifyChildSessions = pickBool(source.notifyChildSessions, DEFAULTS.notifyChildSessions)
  cfg.includeSnippet = pickBool(source.includeSnippet, DEFAULTS.includeSnippet)
  cfg.sound = pickBool(source.sound, DEFAULTS.sound)
  cfg.appProbe = pickBool(source.appProbe, DEFAULTS.appProbe)
  cfg.dryRun = pickBool(source.dryRun, DEFAULTS.dryRun)
  cfg.minTurnDurationMs = pickNumber(source.minTurnDurationMs, DEFAULTS.minTurnDurationMs, 0)
  cfg.snippetChars = pickNumber(source.snippetChars, DEFAULTS.snippetChars, 20, 2000)
  cfg.throttleMs = pickNumber(source.throttleMs, DEFAULTS.throttleMs, 0)
  cfg.disableAfterFailures = pickNumber(source.disableAfterFailures, DEFAULTS.disableAfterFailures, 0)
  cfg.execTimeoutMs = pickNumber(source.execTimeoutMs, DEFAULTS.execTimeoutMs, 500, 120000)
  cfg.notificationId = pickString(source.notificationId, DEFAULTS.notificationId)
  cfg.group = typeof source.group === 'string' ? source.group : DEFAULTS.group
  cfg.tapUrl = typeof source.tapUrl === 'string' ? source.tapUrl : DEFAULTS.tapUrl
  cfg.priority = PRIORITIES.includes(source.priority) ? source.priority : DEFAULTS.priority
  // 振动允许数字或 "500,1000,200" 形式的 pattern 字符串。
  if (typeof source.vibrateMs === 'string' && /^\d+(,\d+)*$/.test(source.vibrateMs)) cfg.vibrateMs = source.vibrateMs
  else cfg.vibrateMs = pickNumber(source.vibrateMs, DEFAULTS.vibrateMs, 0)
  cfg.vibrateVia = source.vibrateVia === 'notification' ? 'notification' : DEFAULTS.vibrateVia
  cfg.vibrateForce = pickBool(source.vibrateForce, DEFAULTS.vibrateForce)
  cfg.headsUp = pickBool(source.headsUp, DEFAULTS.headsUp)
  cfg.headsUpChannel = pickString(source.headsUpChannel, DEFAULTS.headsUpChannel)
  cfg.longTurnMs = pickNumber(source.longTurnMs, DEFAULTS.longTurnMs, 1000)
  cfg.voice = pickBool(source.voice, DEFAULTS.voice)
  cfg.voiceTemplate = typeof source.voiceTemplate === 'string' ? source.voiceTemplate : DEFAULTS.voiceTemplate
  cfg.voiceLanguage = typeof source.voiceLanguage === 'string' ? source.voiceLanguage : DEFAULTS.voiceLanguage
  cfg.voiceRate = pickNumber(source.voiceRate, DEFAULTS.voiceRate, 0.25, 4)
  cfg.voicePitch = pickNumber(source.voicePitch, DEFAULTS.voicePitch, 0.25, 4)
  return cfg
}

/** 单引号包裹，供 `sh -c` / `dash -c` 使用。 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 去掉首尾空白并截断到 max 个字符。 */
function clampText(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 折叠所有空白为单空格后截断 —— 用于摘要/标题这类单行文本。 */
function flat(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return clampText(text, max)
}

/** 毫秒转人类可读的短耗时。 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}

/** 在 PATH 里定位一个可执行文件（同步，用于启动期告警）。 */
function findOnPath(bin) {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    try {
      if (existsSync(join(dir, bin))) return join(dir, bin)
    } catch {
      /* 无法读取的 PATH 项直接跳过 */
    }
  }
  return undefined
}

/**
 * 工具名 → 中文口语。TTS 直接念英文工具名（`Bash`、`str_replace_editor`）非常生硬，
 * 正文里也一样不友好，所以统一过一层映射；映射不到就原样使用。
 */
const TOOL_LABELS = {
  bash: '命令行', pwsh: '命令行', shell: '命令行', terminal: '命令行',
  read: '读取文件', write: '写入文件',
  edit: '编辑文件', 'str-replace-editor': '编辑文件', str_replace_editor: '编辑文件',
  glob: '查找文件', grep: '搜索内容', fs_search: '搜索内容',
  web_search: '网络搜索', web_fetch: '抓取网页',
  todo: '待办清单', todo_write: '待办清单',
  subagent: '子任务', subagent_fork: '子任务', task: '子任务',
  workflow: '工作流', ralph: '循环任务', goal: '目标', jobs: '后台任务',
  present: '交付文件', skill: '技能', ask_user_question: '提问', plan: '计划',
}

/**
 * 把工具名映射成中文口语。
 * @param raw - 原始工具名。
 * @returns 中文标签；映射不到时返回原名。
 */
function toolLabel(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') return '工具'
  const lower = name.toLowerCase()
  if (TOOL_LABELS[lower] !== undefined) return TOOL_LABELS[lower]
  // `mcp__server__tool` / `server/tool` 这类包装：取最后一段再试
  const tail = lower.split(/[.:/]+|__+/).filter(Boolean).pop()
  if (tail !== undefined && TOOL_LABELS[tail] !== undefined) return TOOL_LABELS[tail]
  return name
}

/**
 * 推导 Termux:API 的底层助手路径：`<prefix>/libexec/termux-api`。
 * 由 `termux-notification` 的位置反推 prefix，比读 $PREFIX 更可靠（PATH 里可能有别的同名命令）。
 * @returns 助手路径，找不到返回 undefined。
 */
function defaultChannelHelper() {
  const bin = findOnPath('termux-notification')
  if (bin === undefined) return undefined
  const helper = join(dirname(dirname(bin)), 'libexec', 'termux-api')
  return existsSync(helper) ? helper : undefined
}

/**
 * 设置命名空间的 schema。
 *
 * 刻意用 `z.any()` 而不是真实类型：宿主在 `register()` 时会**立即**用这份 schema
 * 解析「组合配置 + 用户层」，解析失败会直接抛错 —— 那会发生在插件激活期间，
 * 手工把 settings.yaml 或 patch 配置写错一个类型就可能连累整个 profile 启动。
 * 所以这里只保证两件事：缺字段补默认值、任何字段值都接受；
 * 真正的类型与范围校验由 {@link normalizeConfig}（宿主运行时）和设置卡片的表单（写入前）负责。
 */
const SettingsSchema = z.object({
  enabled: z.any().default(DEFAULTS.enabled),
  notifyOnQuestion: z.any().default(DEFAULTS.notifyOnQuestion),
  notifyOnApproval: z.any().default(DEFAULTS.notifyOnApproval),
  notifyOnTurnEnd: z.any().default(DEFAULTS.notifyOnTurnEnd),
  notifyChildSessions: z.any().default(DEFAULTS.notifyChildSessions),
  minTurnDurationMs: z.any().default(DEFAULTS.minTurnDurationMs),
  includeSnippet: z.any().default(DEFAULTS.includeSnippet),
  snippetChars: z.any().default(DEFAULTS.snippetChars),
  notificationId: z.any().default(DEFAULTS.notificationId),
  group: z.any().default(DEFAULTS.group),
  priority: z.any().default(DEFAULTS.priority),
  sound: z.any().default(DEFAULTS.sound),
  vibrateMs: z.any().default(DEFAULTS.vibrateMs),
  vibrateVia: z.any().default(DEFAULTS.vibrateVia),
  vibrateForce: z.any().default(DEFAULTS.vibrateForce),
  headsUp: z.any().default(DEFAULTS.headsUp),
  headsUpChannel: z.any().default(DEFAULTS.headsUpChannel),
  longTurnMs: z.any().default(DEFAULTS.longTurnMs),
  voice: z.any().default(DEFAULTS.voice),
  voiceTemplate: z.any().default(DEFAULTS.voiceTemplate),
  voiceLanguage: z.any().default(DEFAULTS.voiceLanguage),
  voiceRate: z.any().default(DEFAULTS.voiceRate),
  voicePitch: z.any().default(DEFAULTS.voicePitch),
  tapUrl: z.any().default(DEFAULTS.tapUrl),
  throttleMs: z.any().default(DEFAULTS.throttleMs),
  appProbe: z.any().default(DEFAULTS.appProbe),
  disableAfterFailures: z.any().default(DEFAULTS.disableAfterFailures),
  execTimeoutMs: z.any().default(DEFAULTS.execTimeoutMs),
  dryRun: z.any().default(DEFAULTS.dryRun),
})

/**
 * 默认执行器：带硬超时与进程组清理。
 *
 * `detached: true` 让子进程成为进程组组长，超时时对整个组发 SIGKILL —— 因为
 * `termux-notification` 是 bash 包装脚本，真正的 `termux-api-broadcast` 是它的子进程，
 * 只杀直接子进程会留下挂起的广播进程。
 *
 * @param file - 可执行文件。
 * @param args - 参数数组。
 * @param options - `{ timeoutMs }`。
 * @returns 成功时 resolve stdout+stderr 文本。
 */
function defaultExec(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.execTimeoutMs
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(`${stdout}${stderr}`)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 进程可能已经退出 */
        }
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (timedOut) {
        const label = file.split('/').pop() ?? file
        const hint = label === 'termux-notification' ? '（通常是 Termux:API 应用未安装）' : ''
        finish(new Error(`${label} 在 ${timeoutMs}ms 内没有返回${hint}`))
        return
      }
      if (code !== 0) {
        const detail = stderr.trim()
        finish(new Error(`termux-notification 退出码 ${code}${detail ? `：${detail}` : ''}`))
        return
      }
      const out = `${stdout}${stderr}`.trim()
      if (/is not installed|Cannot execute|Unable to|does not exist/i.test(out)) {
        finish(new Error(out))
        return
      }
      finish()
    })
  })
}

/**
 * 默认探测：Termux:API 应用是否安装。
 * @returns `true` 已安装 / `false` 未安装 / `undefined` 无法判断（此时不做停用决定）。
 */
function defaultProbeApp() {
  return defaultExec('sh', ['-c', 'cmd package list packages 2>/dev/null || pm list packages 2>/dev/null'], { timeoutMs: 5000 })
    .then((out) => {
      const text = String(out ?? '')
      if (!/package:/.test(text)) return undefined
      return /package:com\.termux\.api(\s|$)/.test(text)
    }, () => undefined)
}

/**
 * 通知器：把「该发什么通知」与「怎么发」分开，便于测试时注入假的 exec / probe。
 * @param config - 原始配置。
 * @param deps - 测试用注入点 `{ exec, log, now, findBin, probeApp }`。
 */
function createNotifier(config, deps = {}) {
  // 可变：设置页改动后由 setConfig() 重新规范化，所有闭包立刻看到新值。
  let cfg = normalizeConfig(config)
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const exec = typeof deps.exec === 'function' ? deps.exec : defaultExec
  const findBin = typeof deps.findBin === 'function' ? deps.findBin : () => findOnPath('termux-notification')
  const findOpener = typeof deps.findOpener === 'function' ? deps.findOpener : () => findOnPath('termux-open-url')
  const findVibrateBin = typeof deps.findVibrateBin === 'function' ? deps.findVibrateBin : () => findOnPath('termux-vibrate')
  const findTtsBin = typeof deps.findTtsBin === 'function' ? deps.findTtsBin : () => findOnPath('termux-tts-speak')
  const channelHelper = typeof deps.channelHelper === 'function' ? deps.channelHelper : () => defaultChannelHelper()
  const probeApp = typeof deps.probeApp === 'function' ? deps.probeApp : defaultProbeApp

  const titles = new Map()
  const snippets = new Map()
  const turnStarts = new Map()
  const state = {
    sent: 0,
    skipped: 0,
    failures: 0,
    degraded: false,
    warnedMissing: false,
    warnedFailure: false,
    warnedVibrate: false,
    warnedVibrateFailure: false,
    warnedChannel: false,
    warnedVoice: false,
    warnedVoiceFailure: false,
    channelReady: false,
    channelInFlight: undefined,
    alertSeq: 0,
    ttsInFlight: false,
    voiceFailures: 0,
    voiceDisabled: false,
    lastKey: '',
    lastAt: 0,
  }

  function emit(level, message) {
    try {
      log(level, message)
    } catch {
      /* 日志失败不能影响通知调用方 */
    }
  }

  /** 组装 termux-notification 的 argv。 */
  function buildTermuxArgs(payload, plan, channel) {
    const args = [
      '--id', payload.notificationTag,
      '--title', payload.title,
      '--content', payload.content,
    ]
    // 优先级按场景：需要你操作的用配置值（默认 high），结果类固定 default，避免打断。
    const priority = payload.priority ?? cfg.priority
    if (priority) args.push('--priority', priority)
    // 悬浮横幅时不加 --group：通知分组在不少 ROM 上会抑制横幅。
    if (cfg.group && typeof channel !== 'string') args.push('--group', cfg.group)
    if (cfg.sound) args.push('--sound')
    // 只有「走通知渠道」的震动方案才加 --vibrate；走 Termux API 时由 termux-vibrate 负责。
    if (plan !== null && plan.mode === 'notification') args.push('--vibrate', String(cfg.vibrateMs))
    // 只有通道确实建好了才引用它：传不存在的 channel id 会让通知被系统直接丢弃。
    if (typeof channel === 'string' && channel !== '') args.push('--channel', channel)
    if (cfg.tapUrl) args.push('--action', `termux-open-url ${shellQuote(cfg.tapUrl)}`)
    return args
  }

  /**
   * 悬浮通知通道的创建/更新。首次调用真正执行，成功后缓存；失败只告警一次并返回 undefined
   * （调用方据此退回默认通道，保证通知不会因为通道 id 不存在而消失）。
   * @returns 可用的通道 id，或 undefined（本次不使用专用通道）
   */
  function ensureChannel(payload, options = {}) {
    // 只有「需要你操作」的通知才弹横幅；结果类不打扰。
    if (payload?.actionable !== true || !cfg.headsUp) return Promise.resolve(undefined)
    if (options.force === true) state.channelReady = false
    if (state.channelReady) return Promise.resolve(cfg.headsUpChannel)
    if (state.channelInFlight !== undefined) return state.channelInFlight
    const helper = channelHelper()
    if (helper === undefined) {
      if (!state.warnedChannel) {
        state.warnedChannel = true
        emit('warn', '找不到 Termux:API 的 libexec/termux-api，悬浮通知通道建不了；通知照常发，但可能不会弹出横幅（修复：pkg install termux-api）')
      }
      return Promise.resolve(undefined)
    }
    state.channelInFlight = Promise.resolve()
      .then(() => exec(helper, [
        'NotificationChannel',
        '--es', 'id', cfg.headsUpChannel,
        '--es', 'name', CHANNEL_NAME,
        '--es', 'priority', 'high',
      ], { timeoutMs: cfg.execTimeoutMs }))
      .then((out) => {
        const text = String(out ?? '')
        // 助手脚本把失败也当数据返回（退出码 0），所以要读文本判断。
        if (/Could not create|only available/i.test(text)) throw new Error(text.trim())
        return cfg.headsUpChannel
      })
      // 收尾必须单独一段：同一个 .then 的 onRejected 接不住它自己 onFulfilled 抛出的错，
      // 那样错误会穿透出去让整条通知发送失败（而不是退回默认通道）。
      .then((channel) => {
        state.channelReady = true
        return channel
      }, (error) => {
        if (!state.warnedChannel) {
          state.warnedChannel = true
          emit('warn', `创建悬浮通知通道失败，本次运行退回默认通道：${error?.message ?? error}`)
        }
        return undefined
      })
      .finally(() => { state.channelInFlight = undefined })
    return state.channelInFlight
  }

  /**
   * 把模板渲染成要念出来的文本（单趟替换，避免值里含占位符被二次替换）。
   * `{speech}` 是该场景预置的短句（「动作 + 对象」），默认模板就是它 ——
   * TTS 念超过十来个字就显得啰嗦，连续触发时尤其明显。
   */
  function renderVoiceText(payload) {
    const template = cfg.voiceTemplate.trim() === '' ? DEFAULTS.voiceTemplate : cfg.voiceTemplate
    const values = { speech: payload.speech ?? payload.title, title: payload.title, content: payload.content }
    return template.replace(/\{(speech|title|content)\}/g, (_match, key) => values[key] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  }

  /**
   * 语音播报（best-effort：失败只告警一次，绝不影响通知投递）。
   *
   * `termux-tts-speak` 会**阻塞到播完**才返回，所以超时按文本长度自适应：
   * 用统一的通知超时会把长句念到一半就杀掉。
   * @param payload - 场景 payload（用其中的 `speech`）。
   */
  function speak(payload) {
    if (!cfg.voice) return
    // termux-tts-speak 会阻塞到「自己那条」念完；如果上一条还在念，再发一条会排队，
    // 既拖长等待也容易超过超时被杀。通知是即时提醒，宁可跳过也不要堆积陈旧的播报。
    if (state.ttsInFlight) return
    if (state.voiceDisabled) return
    const bin = findTtsBin()
    if (bin === undefined) {
      if (!state.warnedVoice) {
        state.warnedVoice = true
        emit('warn', '找不到 termux-tts-speak，语音通知已跳过（修复：pkg install termux-api）')
      }
      return
    }
    const text = renderVoiceText(payload)
    if (text === '') return
    const args = []
    if (cfg.voiceLanguage.trim() !== '') args.push('-l', cfg.voiceLanguage.trim())
    // 显式传：Termux:API 无论如何都会 setSpeechRate/setPitch，不传就是 1.0，
    // 所以「不传」并不等于「跟随系统」，只会静默变成 1.0。
    args.push('-r', String(cfg.voiceRate), '-p', String(cfg.voicePitch), text)
    // 下限 20 秒：实测正常播报约 0.6 秒/字（4 字 2.7 秒），首次合成会慢一些。
    // 超时只用于兜住「引擎被堵住」的情况，避免子进程永久挂住。
    const timeoutMs = Math.min(90000, Math.max(20000, text.length * 600))
    state.ttsInFlight = true
    Promise.resolve()
      .then(() => exec(bin, args, { timeoutMs }))
      .then(() => { state.voiceFailures = 0 }, (error) => {
        state.voiceFailures += 1
        if (!state.warnedVoiceFailure) {
          state.warnedVoiceFailure = true
          emit('warn', `语音播报失败（通知照常发出）：${error?.message ?? error}。若 termux-tts-speak 单独执行也一直不返回，说明系统 TTS 引擎卡住了：换一个引擎或重启手机；把「语音通知」关掉可停止尝试`)
        }
        if (cfg.disableAfterFailures > 0 && state.voiceFailures >= cfg.disableAfterFailures) {
          state.voiceDisabled = true
          emit('warn', `语音播报连续 ${state.voiceFailures} 次失败，本次运行已停止播报（重载插件后可重试；也请检查系统 TTS 引擎）`)
        }
      })
      .finally(() => { state.ttsInFlight = false })
  }

  /**
   * 决定这次怎么振动。
   *
   * 默认走 `termux-vibrate`（直接调系统 Vibrator，不受通知渠道设置影响）——
   * 通知自带的 `--vibrate` 在 Android 8+ 上经常被渠道设置忽略，这是「设了震动却不振」的主因。
   *
   * 只有能表达为单一毫秒时长时才用 termux-vibrate；`"500,1000,200"` 这类 pattern
   * 无法用它表达，只能交给通知渠道。
   * @returns `{ mode: 'termux-api', bin, durationMs }` / `{ mode: 'notification' }` / `null`（不振动）
   */
  function vibratePlan() {
    const duration = cfg.vibrateMs
    if (duration === 0 || duration === '0') return null
    if (cfg.vibrateVia === 'notification') return { mode: 'notification' }
    if (typeof duration !== 'number') return { mode: 'notification' }
    const bin = findVibrateBin()
    if (bin !== undefined) return { mode: 'termux-api', bin, durationMs: duration }
    if (!state.warnedVibrate) {
      state.warnedVibrate = true
      emit('warn', '找不到 termux-vibrate，震动退回通知的 --vibrate（Android 8+ 上可能被通知渠道设置忽略）；修复：pkg install termux-api')
    }
    return { mode: 'notification' }
  }

  /** termux-vibrate 的 argv（注意它是 getopts，只能用 -d / -f）。 */
  function vibrateArgs(plan) {
    const args = ['-d', String(plan.durationMs)]
    if (cfg.vibrateForce) args.push('-f')
    return args
  }

  /**
   * 触发一次振动（best-effort：失败只告警一次，绝不影响通知投递）。
   * @param plan - vibratePlan() 的结果。
   */
  function fireVibrate(plan) {
    if (plan === null || plan.mode !== 'termux-api') return
    Promise.resolve()
      .then(() => exec(plan.bin, vibrateArgs(plan), { timeoutMs: cfg.execTimeoutMs }))
      .catch((error) => {
        if (!state.warnedVibrateFailure) {
          state.warnedVibrateFailure = true
          emit('warn', `调用 termux-vibrate 失败（通知照常发出）：${error?.message ?? error}`)
        }
      })
  }

  /**
   * 真正投递一条通知。与 {@link send} 的区别：这里返回 Promise 并**抛出**失败原因，
   * 供「检测环境」这类需要拿到结果的地方 await；日常通知走 send() 的 fire-and-forget。
   * 振动是附带动作，失败不影响本 Promise 的结果。
   * @param payload - `{ tag, title, content }`。
   * @returns 成功时 resolve。
   */
  /**
   * 通知 tag。
   *
   * 需要弹悬浮横幅时**必须用全新的 tag**：Termux:API 把 `--id` 当通知 tag 用
   * （`notify(tag, 0, ...)`），同一个 tag 重发是**更新**已有通知，而 Android 不会为更新
   * 再弹横幅 —— 这正是「权限都给了却还是不悬浮」的原因。
   */
  function tagFor(payload, headsUp) {
    const base = `${cfg.notificationId}-${payload.tag}`
    if (!headsUp) return base
    state.alertSeq += 1
    return `${base}-${now()}-${state.alertSeq}`
  }

  async function deliver(payload) {
    const plan = vibratePlan()
    speak(payload)
    const bin = findBin()
    if (!bin) throw new Error('PATH 里找不到 termux-notification（需要 pkg install termux-api）')
    // 必须先建好通道再引用它；建不成时 ensureChannel() 返回 undefined，退回默认通道。
    const channel = await ensureChannel(payload)
    payload.notificationTag = tagFor(payload, typeof channel === 'string')
    const job = Promise.resolve().then(() => exec(bin, buildTermuxArgs(payload, plan, channel), { timeoutMs: cfg.execTimeoutMs }))
    fireVibrate(plan)
    return job
  }

  /** 失败计数：第一条失败给完整指引，达到阈值后本次运行内停用。 */
  function countFailure(error) {
    state.failures += 1
    if (!state.warnedFailure) {
      state.warnedFailure = true
      const message = error?.message ?? String(error)
      const missingCommand = message.includes('termux-notification')
      emit('warn', `发送通知失败：${message}。${missingCommand ? '请先执行 `pkg install termux-api`。' : ''}若未安装 Termux:API 应用，请从 F-Droid 或 GitHub Releases 安装「Termux:API」`)
    }
    if (cfg.disableAfterFailures > 0 && state.failures >= cfg.disableAfterFailures) {
      state.degraded = true
      emit('warn', `连续 ${state.failures} 次发送失败，本次运行内停止发送通知（设置页里「发一条测试通知」成功即可恢复，或重载插件）`)
    }
  }

  /**
   * 发送一条通知（fire-and-forget，永不抛出）。
   * @param payload - `{ tag, title, content }`。
   * @returns 是否真的进入了发送流程。
   */
  function send(payload) {
    try {
      if (!cfg.enabled || state.degraded) return false
      const key = `${payload.tag}\u0000${payload.title}\u0000${payload.content}`
      const at = now()
      if (cfg.throttleMs > 0 && key === state.lastKey && at - state.lastAt < cfg.throttleMs) {
        state.skipped += 1
        return false
      }
      state.lastKey = key
      state.lastAt = at
      if (cfg.dryRun) {
        const kind = payload.actionable === true ? '需操作' : '结果'
        const spoken = renderVoiceText(payload)
        emit('info', `[dry-run] 【${kind}】${payload.title} :: ${payload.content.replace(/\n+/g, ' | ')}${spoken === '' ? '' : ` :: 语音「${spoken}」`}`)
        state.sent += 1
        return true
      }
      deliver(payload).then(
        () => { state.sent += 1; state.failures = 0 },
        (error) => countFailure(error),
      )
      return true
    } catch (error) {
      emit('warn', `组装通知失败：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 环境自检：按顺序验证「插件开关 → 命令 → Termux:API 应用 → 点击打开浏览器 → 运行状态」，
   * 可选再真发一条测试通知（这是唯一能证明通道确实可用的检查）。
   *
   * 试发成功会顺手复位「本次运行已停用」——装好 APK 后不必重启 DSH 就能恢复。
   *
   * @param options - `{ sendTest }`：是否真发一条测试通知。
   * @returns `{ ok, sent, summary, steps, config }`，可直接 JSON 序列化给浏览器。
   */
  async function runEnvironmentCheck(options = {}) {
    const sendTest = options.sendTest === true
    const steps = []
    const step = (key, title, status, detail, hint) => {
      steps.push({
        key,
        title,
        status,
        ...detail === undefined ? {} : { detail },
        ...hint === undefined ? {} : { hint },
      })
    }

    // 0) 需要悬浮时先把通道重新断言一次：用户刚给完权限、或改过通道设置后，
    //    点一次「检测环境」就能拿到一个重要性 HIGH 的通道。
    if (cfg.headsUp) await ensureChannel({ actionable: true }, { force: true })

    // 1) 插件自身配置：不是环境问题，但直接决定会不会发通知
    if (!cfg.enabled) step('config', '插件总开关', 'warn', '设置里已关闭（enabled = false）', '把这张页面上的「总开关」打开')
    else if (cfg.dryRun) step('config', '插件总开关', 'warn', '当前是 dry-run 模式，只写日志不真发', '把「只写日志（dry-run）」关掉')
    else step('config', '插件总开关', 'ok', '已启用')

    // 2) 命令是否存在
    const bin = findBin()
    if (bin) step('command', 'termux-notification 命令', 'ok', bin)
    else {
      step('command', 'termux-notification 命令', 'fail', 'PATH 里找不到 termux-notification',
        '在 Termux 里执行：pkg install termux-api')
    }

    // 3) Termux:API 应用是否安装
    if (bin) {
      let installed
      try {
        installed = await probeApp()
      } catch {
        installed = undefined
      }
      if (installed === true) step('app', 'Termux:API 应用', 'ok', 'com.termux.api 已安装')
      else if (installed === false) {
        step('app', 'Termux:API 应用', 'fail', '没有找到 com.termux.api 包',
          '从 F-Droid 安装 Termux:API 应用：https://f-droid.org/packages/com.termux.api/')
      } else {
        step('app', 'Termux:API 应用', 'warn', '拿不到应用列表，判断不了',
          '缺应用时 termux-notification 会一直挂起；用「发一条测试通知」确认')
      }
    }

    // 4) 点击通知打开浏览器（本插件预期的点击手感）
    if (cfg.tapUrl) {
      if (findOpener()) {
        step('tap', '点击通知打开浏览器', 'ok', `点击将执行：termux-open-url ${cfg.tapUrl}`)
      } else {
        step('tap', '点击通知打开浏览器', 'warn', 'PATH 里找不到 termux-open-url',
          '它随 termux-tools 提供：pkg install termux-tools')
      }
    } else {
      step('tap', '点击通知打开浏览器', 'warn', 'tapUrl 是空的 —— 点击通知会打开 Termux 应用',
        '想让点击回到 DSH 页面，把「点击通知打开」填成 http://127.0.0.1:3080/')
    }

    // 4b) 振动：说明这次到底会怎么振，以及为什么可能不振
    const duration = cfg.vibrateMs
    if (duration === 0 || duration === '0') {
      step('vibrate', '振动', 'skip', '已关闭（振动 = 0）',
        '想要振动就往「振动」里填毫秒数，例如 1000')
    } else if (cfg.vibrateVia === 'notification') {
      step('vibrate', '振动', 'warn', `走通知渠道的 --vibrate ${duration}`,
        'Android 8+ 上通知的振动受「通知渠道」设置控制，经常被忽略；把「振动方式」改成 termux-api 可靠得多')
    } else if (typeof duration !== 'number') {
      step('vibrate', '振动', 'warn', `pattern ${duration} 只能走通知渠道的 --vibrate`,
        'termux-vibrate 只能按毫秒振动；想更可靠就填单个毫秒数（例如 1000）')
    } else if (findVibrateBin() === undefined) {
      step('vibrate', '振动（Termux API）', 'fail', 'PATH 里找不到 termux-vibrate',
        '在 Termux 里执行：pkg install termux-api')
    } else {
      step('vibrate', '振动（Termux API）', 'ok',
        `试发时会执行：termux-vibrate -d ${duration}${cfg.vibrateForce ? ' -f' : ''}`,
        cfg.vibrateForce
          ? '已带 -f：系统静音/仅振动模式下也会振'
          : '未带 -f：系统静音/仅振动模式下可能不振；打开「静音也振动」可强制')
    }

    // 4c) 悬浮通知（heads-up）
    if (!cfg.headsUp) {
      step('headsUp', '悬浮通知', 'skip', '已关闭 —— 通知只进通知栏，不弹横幅',
        '打开后会用一个重要性 HIGH 的专用通道，让通知像横幅一样弹出来')
    } else if (channelHelper() === undefined) {
      step('headsUp', '悬浮通知', 'fail', '找不到 Termux:API 的底层助手 libexec/termux-api',
        '它随 termux-api 包提供：pkg install termux-api')
    } else {
      step('headsUp', '悬浮通知', 'ok', `需要你操作时用通道 ${cfg.headsUpChannel}（重要性 HIGH）「${CHANNEL_NAME}」；结果类不弹`,
        '仍不弹的话：① 确认屏幕是亮的（息屏不弹横幅）② 看系统里该通道的重要性是否被调低过，'
        + '被调低的通道程序改不回来，把「悬浮通道」换个新值（如 dsh-heads-up2）就能建一个全新通道')
    }

    // 4d) 语音通知
    if (!cfg.voice) {
      step('voice', '语音通知', 'skip', '已关闭',
        '打开后会调用 termux-tts-speak 把通知念出来')
    } else if (findTtsBin() === undefined) {
      step('voice', '语音通知', 'fail', 'PATH 里找不到 termux-tts-speak',
        '在 Termux 里执行：pkg install termux-api')
    } else {
      let engines = ''
      try {
        engines = String(await exec('termux-tts-engines', [], { timeoutMs: cfg.execTimeoutMs }) ?? '')
      } catch {
        engines = ''
      }
      const lang = cfg.voiceLanguage.trim()
      const spoken = renderVoiceText({ speech: '需要你选择，选模式', title: '❓ 需要选择', content: '（问题摘要）' })
      const detail = `将念出：${spoken}（${lang === '' ? '语言跟随系统' : `语言 ${lang}`}，语速 ${cfg.voiceRate}，音调 ${cfg.voicePitch}）`
      if (engines.includes('label') || engines.includes('"name"')) {
        step('voice', '语音通知', 'ok', detail,
          '语速/音调由插件传给 Termux:API —— 它会覆盖系统「文字转语音」里的设置，'
          + '想和手机一致就把这两项填成同一个值。播报走 NOTIFICATION 音频流，系统静音时通常不出声')
      } else {
        step('voice', '语音通知', 'warn', `${detail} —— 但 termux-tts-engines 没有返回可用引擎`,
          '先在 Termux 里手敲 `termux-tts-speak 测试`：① 能出声 → 无需处理；② 一直卡住不返回 → '
          + '系统的 TTS 引擎卡死了，去系统设置换一个引擎、或重启手机；③ 报错 → 去系统设置 → '
          + '语言与输入/无障碍 → 文字转语音，安装或选择一个引擎')
      }
    }

    // 5) 本次运行的发送状态
    if (state.degraded) {
      step('runtime', '插件运行状态', 'warn', '本次运行已停用通知（启动探测失败或连续发送失败）',
        '发一条测试通知成功后会自动恢复；也可以重启 DSH')
    } else {
      step('runtime', '插件运行状态', 'ok', `已发送 ${state.sent} 条，当前连续失败 ${state.failures} 次`)
    }

    // 6) 可选：真发一条
    if (sendTest) {
      try {
        await deliver({
          tag: 'test',
          // 当作「需要你操作」处理：这样试发就能演示悬浮横幅（每次都是全新 tag，一定弹）
          actionable: cfg.headsUp,
          title: '🔔 测试通知',
          content: '看到这条通知说明通道可用；点一下它，应该用系统浏览器打开 DSH 页面。',
          speech: '测试通知',
        })
        state.degraded = false
        state.failures = 0
        step('send', '试发一条通知', 'ok', '已发出 —— 看看通知栏，并试着点一下')
      } catch (error) {
        step('send', '试发一条通知', 'fail', error?.message ?? String(error),
          '若是超时或挂起，通常是 Termux:API 应用没装好、或被系统限制了后台运行')
      }
    }

    const failed = steps.some((item) => item.status === 'fail')
    const warned = steps.some((item) => item.status === 'warn')
    const sentOk = steps.some((item) => item.key === 'send' && item.status === 'ok')
    const summary = failed
      ? '环境还不完整 —— 按下面的提示修一下'
      : sentOk ? '通道可用，通知已经发出'
        : warned ? '基本可用，但有几处需要留意' : '环境就绪'
    return { ok: !failed, sent: sentOk, summary, steps, config: { ...cfg } }
  }

  /**
   * 需要你操作：回答问题 → ❓ 需要选择。
   *
   * 标题是「emoji + 2~4 字」，正文放关键变量（问题摘要 + 选项），
   * 语音只留「动作 + 对象」。
   */
  function questionPayload(questions) {
    const first = questions[0] ?? {}
    const header = typeof first.header === 'string' && first.header.trim() !== '' ? `${first.header.trim()}：` : ''
    const asked = typeof first.question === 'string' ? first.question.trim() : ''
    const summary = flat(`${header}${asked}`, 60) || '模型在等待你的回答'
    const options = Array.isArray(first.options)
      ? first.options.map((option) => option?.label).filter((label) => typeof label === 'string' && label.trim() !== '')
      : []
    const body = [
      summary,
      options.length > 0 ? `选项：${options.slice(0, 4).join(' / ')}${options.length > 4 ? ' …' : ''}` : '',
      questions.length > 1 ? `…还有 ${questions.length - 1} 个问题` : '',
    ].filter(Boolean).join('\n')
    return {
      tag: 'question',
      actionable: true,
      title: '❓ 需要选择',
      content: clampText(body, 400),
      speech: `需要你选择，${clampText(summary, 14)}`,
    }
  }

  /**
   * 需要你操作：审批。
   * 有工具名 → ⚠️ 需要确认（工具：{中文名}）；没有工具名 → 🔐 权限请求（{resource}）。
   */
  function approvalPayload(request) {
    const reason = typeof request?.reason === 'string'
      ? request.reason.trim()
      : request?.reason !== undefined ? flat(JSON.stringify(request.reason), 120) : ''
    const rawTool = typeof request?.toolName === 'string' ? request.toolName.trim() : ''
    if (rawTool === '') {
      const resource = reason || '未说明的权限'
      return {
        tag: 'permission',
        actionable: true,
        title: '🔐 权限请求',
        content: clampText(resource, 300),
        speech: `请求权限，${clampText(resource, 14)}`,
      }
    }
    const label = toolLabel(rawTool)
    return {
      tag: 'approval',
      actionable: true,
      title: '⚠️ 需要确认',
      content: clampText([`工具：${label}`, reason].filter(Boolean).join('\n'), 300),
      speech: `需要你确认，${clampText(label, 14)}`,
    }
  }

  /**
   * 结果类：不需要立即响应，所以固定默认优先级、不弹横幅，语音也只是一句短话。
   * 悬浮正文允许「稍微详细」：状态句 + 会话标题 + 结果摘要。
   */
  function turnPayload(kind, details) {
    const extra = []
    if (details.sessionTitle) extra.push(flat(details.sessionTitle, 60))
    if (cfg.includeSnippet && details.snippet) extra.push(flat(details.snippet, cfg.snippetChars))
    const build = (title, first, speech) => ({
      tag: 'turn',
      actionable: false,
      priority: 'default',
      title,
      content: clampText([first, ...extra].filter(Boolean).join('\n'), 400),
      speech,
    })
    switch (kind) {
      case 'error':
        return build('❌ 出错了', flat(details.error ?? '', 120) || '本轮出错', '任务出错')
      case 'aborted':
        return build('⏹ 已中止', '用户取消了操作', '任务已中止')
      case 'blocked':
        return build('⏹ 已阻止', '本轮被拒绝，未执行', '任务已阻止')
      case 'max-tokens':
        return build('⚠️ 达到上限', '输出被截断', '任务达到上限')
      default:
        if (details.elapsed !== undefined && details.elapsed >= cfg.longTurnMs) {
          return build('✅ 长任务完成', `耗时 ${formatDuration(details.elapsed)}`, '长任务完成')
        }
        return build('✅ 任务完成', '本轮对话已结束', '任务完成')
    }
  }

  /** 从 assistant 消息里抽出纯文本部分。 */
  function assistantText(message) {
    const content = message?.content
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
    }
    return parts.join('\n').trim()
  }

  /** 一轮结束：拼标题与正文并发送。 */
  function onTurnEnd(session, sessionId, data) {
    const header = session?.header
    const isChild = header !== null && typeof header === 'object'
      && typeof header.parentSession === 'string' && header.parentSession.length > 0
    if (isChild && !cfg.notifyChildSessions) return

    const started = turnStarts.get(sessionId)
    turnStarts.delete(sessionId)
    const elapsed = started && typeof started.at === 'number' ? now() - started.at : undefined
    if (cfg.minTurnDurationMs > 0 && elapsed !== undefined && elapsed < cfg.minTurnDurationMs) return

    const reason = data?.reason !== null && typeof data?.reason === 'object' ? data.reason : {}
    const kind = typeof reason.kind === 'string' ? reason.kind : 'completed'
    const detail = reason.error?.message ?? reason.error?.code
    send(turnPayload(kind, {
      elapsed,
      error: typeof detail === 'string' ? detail : '',
      sessionTitle: titles.get(sessionId),
      snippet: snippets.get(sessionId),
    }))
  }

  return {
    /** 当前生效配置（getter：设置页改动后立即反映）。 */
    get cfg() {
      return cfg
    },
    /** 用一份新的原始配置替换当前配置（来自设置命名空间的解析值或组合配置）。 */
    setConfig(next) {
      cfg = normalizeConfig(next)
      return cfg
    },
    state,

    /**
     * `user-questions/request` waterfall 监听器：先发通知，再委托下游回答者。
     * 必须调用 `next()` —— Cordis waterfall 里不调用就等于否决整条链（包括真正的回答者）。
     */
    onQuestion(request, next) {
      try {
        if (cfg.notifyOnQuestion) {
          const questions = Array.isArray(request?.questions) ? request.questions : []
          if (questions.length > 0) send(questionPayload(questions))
        }
      } catch (error) {
        emit('warn', `处理提问通知失败：${error?.message ?? error}`)
      }
      return typeof next === 'function' ? next() : undefined
    },

    /** `approval/request` waterfall 监听器：先通知，再委托下游应答者。 */
    onApproval(request, next) {
      try {
        if (cfg.notifyOnApproval) send(approvalPayload(request))
      } catch (error) {
        emit('warn', `处理审批通知失败：${error?.message ?? error}`)
      }
      return typeof next === 'function' ? next() : undefined
    },

    /** `session/event` 监听器：维护每会话的标题/摘要/轮次起点，并在 turn/end 时通知。 */
    onSessionEvent(session, event) {
      try {
        const sessionId = session && typeof session.id === 'string' ? session.id : 'unknown'
        const type = event?.type
        const data = event?.data
        if (type === 'session/title') {
          const title = typeof data?.title === 'string' ? data.title.trim() : ''
          if (title) titles.set(sessionId, title)
          return
        }
        if (type === 'assistant/message') {
          const text = assistantText(data?.message)
          if (text) snippets.set(sessionId, text)
          return
        }
        if (type === 'turn/start') {
          // 摘要按轮次隔离：清掉上一轮的，避免本轮没有文本输出时通知里出现陈旧摘要。
          snippets.delete(sessionId)
          turnStarts.set(sessionId, { turn: data?.turn, at: now() })
          return
        }
        if (type === 'turn/end' && cfg.notifyOnTurnEnd) onTurnEnd(session, sessionId, data)
      } catch (error) {
        emit('warn', `处理会话事件失败：${error?.message ?? error}`)
      }
    },

    /** 会话销毁时清掉缓存，避免长跑进程里 Map 无限增长。 */
    onSessionDisposed(session) {
      const sessionId = session && typeof session.id === 'string' ? session.id : undefined
      if (!sessionId) return
      titles.delete(sessionId)
      snippets.delete(sessionId)
      turnStarts.delete(sessionId)
    },

    /** 启动自检：命令是否存在、Termux:API 应用是否就绪，并把结论写进日志。 */
    startupCheck() {
      if (!cfg.enabled) {
        emit('info', '插件已禁用（enabled: false）')
        return
      }
      if (cfg.dryRun) {
        emit('info', 'dry-run 模式：只记录日志，不真正发通知')
        return
      }
      if (!findBin()) {
        state.warnedMissing = true
        state.degraded = true
        emit('warn', '未找到 termux-notification 命令，通知已停用；请先执行 `pkg install termux-api`')
        return
      }
      if (!cfg.appProbe) return
      Promise.resolve()
        .then(() => probeApp())
        .then((installed) => {
          if (installed === true) {
            emit('info', 'Termux:API 就绪，通知通道可用')
            return
          }
          if (installed === false) {
            state.degraded = true
            emit('warn', 'Termux:API 应用未安装，通知已停用。请从 F-Droid 或 GitHub Releases 安装「Termux:API」后重新加载插件（termux-notification 在缺少应用时会一直挂起，所以这里提前停用）')
          }
        })
        .catch(() => {})
    },

    /** 环境自检（设置页的「检测环境 / 发一条测试通知」按钮走它）。 */
    runEnvironmentCheck,

    /** 悬浮通知通道的创建/缓存（测试用；正常路径由 deliver() 调用）。 */
    ensureChannel,

    /** 测试用入口：等价于直接调用内部的 send。 */
    send,
  }
}

/** 从 ctx 取 logger，拿不到就静默丢弃（日志永远不能影响主流程）。 */
function makeLogger(ctx) {
  return (level, message) => {
    try {
      // `ctx.logger` 是 Cordis 的 LoggerService；`ctx.get('logger')` 作为兜底
      // （实测 `new Context()` 下 get('logger') 为 undefined，而 ctx.logger 可用）。
      let logger
      try {
        logger = ctx?.logger
      } catch {
        logger = undefined
      }
      if (typeof logger?.[level] !== 'function' && typeof ctx?.get === 'function') {
        logger = ctx.get('logger') ?? logger
      }
      const sink = logger?.[level] ?? logger?.info
      if (typeof sink === 'function') sink.call(logger, `${name}: ${message}`)
    } catch {
      /* 日志通道不可用时忽略 */
    }
  }
}

/** 设置页「检测环境」调用的路由（客户端 client/client.js 里有一份相同常量）。 */
const CHECK_ROUTE_PATH = '/dsh-termux-notify/check'
/** 检测请求体只有 `{ sendTest }`，任何更大的 body 都当敌意处理。 */
const MAX_CHECK_BODY_BYTES = 4096

/** JSON 响应（no-store：检测结果是即时事实）。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 + 唯一允许的方法。 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** 取有上限的请求体文本；超限返回 null（并把流读干）。 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_CHECK_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * 插件入口：注册三个只读观测点、运行时设置命名空间，以及设置页用的检测路由。
 * @param ctx - Cordis 上下文。
 * @param config - profile patch 里的插件配置。
 */
function apply(ctx, config) {
  const log = makeLogger(ctx)
  const notifier = createNotifier(config, { log })

  // 观测点始终注册，开关在运行时由配置判定 —— 这样在设置页里开关「需要你选择/结果出现」
  // 能立即生效，而不需要重启或重新加载插件。
  // prepend：必须排在真正的 Web 回答者之前，否则要等用户答完才会轮到我们。
  ctx.on('user-questions/request', (request, next) => notifier.onQuestion(request, next), { prepend: true })
  ctx.on('approval/request', (request, next) => notifier.onApproval(request, next), { prepend: true })
  ctx.on('session/event', (session, event) => notifier.onSessionEvent(session, event))
  ctx.on('session/disposed', (session) => notifier.onSessionDisposed(session))

  // 设置页的检测接口。webServer / connection 只在 Web 组合里存在，所以用 ctx.inject 包一层：
  // 其它 profile（headless / sdk）没有这两个服务时自然不注册，插件其余部分照常工作。
  // 路由按官方 open-in-app 的做法先过 connection 的信任栅栏（Host/Origin 校验 + 登录 cookie），
  // 因为「试发一条通知」是有副作用的动作。
  try {
    ctx.inject(['webServer', 'connection'], (routeCtx) => {
      routeCtx.effect(() => routeCtx.webServer.register({
        kind: 'exact',
        path: CHECK_ROUTE_PATH,
        handler: async (req, res) => {
          try {
            const connection = Reflect.get(routeCtx, 'connection')
            const rejection = connection?.requestRejection?.(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            if (req.method !== 'POST') {
              sendMethodNotAllowed(res, 'POST')
              return
            }
            let sendTest = false
            try {
              const body = await readBoundedBody(req)
              if (body && body.trim() !== '') sendTest = JSON.parse(body)?.sendTest === true
            } catch {
              /* 空 body / 非 JSON：按「只检测、不试发」处理 */
            }
            sendJson(res, 200, await notifier.runEnvironmentCheck({ sendTest }))
          } catch (error) {
            log('warn', `环境检测失败：${error?.message ?? error}`)
            sendJson(res, 500, { ok: false, sent: false, summary: `检测失败：${error?.message ?? error}`, steps: [] })
          }
        },
      }), 'dsh-termux-notify: check route')
    })
  } catch (error) {
    log('warn', `注册检测路由失败：${error?.message ?? error}`)
  }

  // 运行时设置命名空间：有设置服务时，用组合配置作为 base 注册，用户改动即时生效；
  // 没有设置服务时（例如独立 SDK 组合）保持组合配置不变，行为与之前完全一致。
  // 整段包在 try/catch 里：设置接线无论出什么问题都不允许影响插件激活本身。
  let readSection = () => config
  const applySection = () => {
    try {
      notifier.setConfig(readSection())
    } catch (error) {
      notifier.setConfig(config)
      log('warn', `读取设置命名空间失败，回退组合配置：${error?.message ?? error}`)
    }
  }
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, SettingsSchema, config, {
        setSource: (source) => {
          readSection = source
          applySection()
        },
        onChange: () => {
          applySection()
        },
      })
    })
  } catch (error) {
    log('warn', `注册设置命名空间失败，本次运行只能用组合配置：${error?.message ?? error}`)
  }

  notifier.startupCheck()
}

export { CHANNEL_ID, CHANNEL_NAME, CHECK_ROUTE_PATH, DEFAULTS, SETTINGS_NAMESPACE, SettingsSchema, apply, createNotifier, defaultExec, name, normalizeConfig, toolLabel }
