# dsh-termux-notify

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 加一条通知通道：**需要你选择、或一轮结果出来时，用 Termux 给手机发系统通知。**

点一下通知，直接用系统浏览器回到 DSH 页面 —— 不用在通知栏上做任何操作。

---

## 它解决什么问题

在 Termux 里跑 DSH 时，你通常会切到别的 App 等结果。于是有两种尴尬：

- 模型其实在等你选一个选项，你却不知道，一直在傻等；
- 一轮跑完了，你也一直在傻等。

装了这个插件，这两种时刻都会推到手机通知栏。

## 效果

通知分成两类，处理方式完全不同：**需要你操作的会弹横幅打断你，结果类只安静地进通知栏。**

### 一、需要你操作（高优先级 + 悬浮横幅 + 一句短语音）

| 场景 | 悬浮标题 | 悬浮正文 | 语音 |
| --- | --- | --- | --- |
| 需要你选择（`ask_user_question`、计划审阅…） | `❓ 需要选择` | 问题摘要 + 选项 | 需要你选择，{摘要} |
| 需要确认工具调用 | `⚠️ 需要确认` | 工具：{工具中文名} | 需要你确认，{工具中文名} |
| 权限请求 | `🔐 权限请求` | {resource} | 请求权限，{resource} |

### 二、结果 / 状态（默认优先级，**不弹横幅**，语音只有一句）

| 场景 | 悬浮标题 | 悬浮正文 | 语音 |
| --- | --- | --- | --- |
| 任务完成 | `✅ 任务完成` | 本轮对话已结束 + 会话标题 + 结果摘要 | 任务完成 |
| 长任务完成（默认 ≥ 60 秒） | `✅ 长任务完成` | 耗时 {duration} + 会话标题 + 结果摘要 | 长任务完成 |
| 出错 | `❌ 出错了` | {error 摘要} | 任务出错 |
| 被中止 | `⏹ 已中止` | 用户取消了操作 | 任务已中止 |

三条设计原则：

- **标题就是 emoji + 2~4 个字**，正文只放关键变量 —— 扫一眼就知道发生了什么，不用点开；
- **语音只留「动作 + 对象」**：TTS 念超过十来个字就显得啰嗦，连续触发时尤其明显。
  工具名会先映射成中文口语（`bash` → 命令行、`str_replace_editor` → 编辑文件），
  否则 TTS 念英文变量名很生硬；
- **区分优先级**：只有「需要你操作」的才用高优先级 + 悬浮横幅，
  「任务完成」这类非紧急消息不会弹出来打断你。

其余默认行为：**振动 1 秒**、**点通知用浏览器打开 DSH 页面**、通知栏上没有按钮，
以及**回到对话时自动清掉过时通知**：新一轮开始、或你在浏览器里回答完提问/审批，那条提醒就会自己消失
（点过的通知本来就由 Android 自动消失，这里清的是没点过的积压）。

---

## 前置条件

1. **Termux 环境里能跑 DSH Web**（`dsh web`）。
2. **安装 `termux-api` 包**：

   ```bash
   pkg install termux-api
   ```

3. **安装「Termux:API」应用**（APK，必须单独装，只装上面的包不够）。
   插件**强依赖 Termux API 一路通道**：没有 `termux-notification` + Termux:API 应用就发不出通知
   （插件会在启动时探测，缺失就停用并在设置页的「检测环境」里写清原因）：

   - F-Droid：<https://f-droid.org/packages/com.termux.api/>
   - 或 GitHub Releases：<https://github.com/termux/termux-api/releases>

   > ⚠️ 这一步不能省。缺少 Termux:API 应用时，`termux-notification` **不会报错，而是一直挂起**，
   > 所以插件会在启动时探测它，发现缺失就直接停用并写一条警告日志（避免每次通知都留下一个僵尸进程）。

4. 顺手检查一下通道是否通（装完应用后跑）：

   ```bash
   PLUGIN_DIR="$HOME/.dsh/profiles/web/node_modules/dsh-termux-notify"
   bash "$PLUGIN_DIR/scripts/check-channel.sh"
   ```

   它会依次检查 `termux-notification` 命令、Termux:API 应用，并带 10 秒硬超时真发一条测试通知。
   退出码 `0/1/2/3` 分别表示：可用 / 缺命令 / 缺应用 / 超时。

---

## 安装

### 推荐方式：把仓库地址发给 DSH，让它自己装

在 DSH 的对话框里粘上这一行，然后说一句「帮我安装这个插件」：

```
https://github.com/xs2966/dsh-termux-notify
```

DSH 会自己去看这个仓库、把它装进 `web` profile、并告诉你需要重启。你只需要在最后重启一次 DSH。

重启方式：在跑 `dsh web` 的那个 Termux 会话里按 `Ctrl+C`，然后照你平时的方式重新启动（如果用了一键启动脚本，就是 `~/dsh/start_dsh-terminal.sh`）。

> 因为 profile 的 `patchReload` 是 `startup`，**装完必须重启一次**才会加载新插件。

### 手动安装（可选）

如果不想让 DSH 自己动手：

```bash
# 如果 dsh 在 PATH 里
dsh plugin --profile web add github:xs2966/dsh-termux-notify

# Termux 上一般要显式用 node 启动（node_modules/.bin/dsh 的 shebang 在本机不可用）
node "$HOME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add github:xs2966/dsh-termux-notify
```

这条命令会把这个包写进 `$HOME/.dsh/profiles/web/package.json` 的依赖和 `dsh.profile.bundles`。
装完同样要重启 DSH。

装完可以确认它确实被组合进了配置树：

```bash
node "$HOME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --dump-config | grep -A 25 dsh-termux-notify
```

---

## 装完先做这三件事

重启 DSH 之后：

1. **看设置里有没有新页面**：打开 **设置 → Termux 通知**。
   它是设置左侧导航里独立的一页（不在「插件」分区里）。
2. **点页面顶部的「检测环境」**：会逐项检查插件开关、`termux-notification` 命令、Termux:API 应用、
   点击行为和振动方式，每一项都给出状态和修复提示。
3. **点「发一条测试通知」**：会真的发一条通知。看到通知后**点它一下**，
   应该用系统浏览器打开 DSH 页面，同时伴随一次振动。
   旁边还有「清空旧通知」，随时手动清掉本插件之前发过的通知。

三步都通过就装好了。任何一步有 ✗，按提示修即可（提示里会写清楚要执行什么命令）。

想更彻底地验证，可以跑一次完整自检 —— 它会检查 profile 组合、宿主半侧能否按包名 import、
客户端 bundle 能否被发现，以及（在源码仓库里）跑全部测试：

```bash
PLUGIN_DIR="$HOME/.dsh/profiles/web/node_modules/dsh-termux-notify"
bash "$PLUGIN_DIR/scripts/check-integration.sh"
```

> 安装副本里没有 `test/`，所以最后一步会提示「跳过测试套件」——这是正常的，
> 决定装不装得上的三项检查都会照常跑。

---

## 设置

打开 **设置 → Termux 通知**。所有改动**立即生效**，不需要重启，也不需要按保存：

- 开关和下拉选完就写入；
- 文本框在**失焦或回车**时提交，`Esc` 撤销本次输入；
- 改过的字段会标「已覆盖」，右侧有「默认」按钮可以单独恢复；
- 页面底部「全部恢复默认」清掉所有个人覆盖。

### 常用设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 总开关 | 开 | 关掉后完全不发通知 |
| 需要你选择时 | 开 | `ask_user_question`、计划审阅等等待你回答的请求 |
| 需要授权时 | 开 | 敏感工具的一次性授权请求 |
| 结果出现时 | 开 | 一轮结束（`turn/end`） |
| 子 agent 轮次也通知 | 关 | 子 agent 的轮次默认不打扰你 |
| 最短耗时（毫秒） | `0` | 填 `5000` 就只通知耗时 ≥ 5 秒的轮次，过滤掉秒回的小轮次 |
| 长任务阈值（毫秒） | `60000` | 耗时达到该值的轮次用「✅ 长任务完成」的说法 |
| 回到对话时清空过时通知 | 开 | 三个触发点：**新一轮开始**、**你回答完提问**、**审批被决定**。撤销本插件发过、还没点掉的通知。**只撤自己的 tag**，不动别的应用；子 agent 的轮次不会清掉主会话的提醒 |
| 附带结果摘要 | 开 | 把模型最后一段文本放进通知正文 |
| 摘要长度（字符） | `120` | 摘要截断长度 |
| 优先级（需要你操作时） | `high` | `high` / `low` / `max` / `min` / `default`；结果类固定 `default` |
| 提示音 | 开 | |
| 振动 | `1000` | 毫秒；`0` = 不振动；也可写 `500,1000,200` 这种 pattern |
| 振动方式 | `termux-api` | `termux-api` = 调用 `termux-vibrate`（推荐，不受通知渠道设置影响）；`notification` = 用通知自带的 `--vibrate` |
| 静音也振动 | 开 | 对应 `termux-vibrate -f`：系统静音/仅振动模式下也振 |
| 悬浮通知 | 开 | 「需要你操作」的通知用**重要性 HIGH** 的专用通道弹横幅；结果类不弹，避免打断 |
| 悬浮通道 | `dsh-heads-up` | 通道 id。改成新值（如 `dsh-heads-up2`）会建一个**全新通道**，用来修复被调低过重要性的旧通道 |
| 点击通知打开 | `http://127.0.0.1:3080/` | 点通知时用 `termux-open-url` 打开这个地址；留空则改为打开 Termux 应用 |
| 通知分组 / id 前缀 | `dsh` | 同类通知覆盖上一条，三类各占一条 |
| 语音通知 | 关 | 额外调 `termux-tts-speak` 把通知念出来（走 `NOTIFICATION` 音频流） |
| 播报内容模板 | `{speech}` | `{speech}` = 该场景的短句（推荐）；也支持 `{title}` `{content}` 自定义成完整句子 |
| 播报语言 | 空 | 例如 `zh` / `en`；留空则由系统 TTS 引擎自行决定 |
| 播报语速 | `1` | `1` = 正常。**Termux:API 会覆盖手机里的语速设置**，想和手机一致就填同一个值（见下面常见问题） |
| 播报音调 | `1` | `1` = 正常。同上，也会被 Termux:API 覆盖 |
| 去重窗口（毫秒） | `1500` | 同内容在这个窗口内只发一次 |
| 只写日志（dry-run） | 关 | 打开后只写日志、不真发通知，用来验证接线 |
| 启动探测 Termux:API 应用 | 开 | 缺失时直接停用，避免每次通知都留下挂起的进程 |

### 配置文件位置（可选）

设置页写的是**用户覆盖**，存在 `$HOME/.dsh/settings.yaml` 的 `termux-notify:` 段。

想改**部署默认值**（对这台机器上所有会话生效、且不受个人覆盖影响），在
`$HOME/.dsh/profiles/web/cordis.patch.yml` 里按 `id` 覆盖：

```yaml
- insert:
    - id: dsh-termux-notify
      name: dsh-termux-notify
      config:
        minTurnDurationMs: 5000
        vibrateMs: 0
        headsUp: false
```

> patch 是**整份 config 替换**而不是逐键合并：没写出来的键会由插件内置默认值补齐，
> 所以只写你关心的几个键是安全的。
>
> 优先级：内置默认 < patch 部署配置 < `settings.yaml` 用户覆盖（设置页）。

---

## 常见问题

**收不到通知**

1. 先跑 `scripts/check-channel.sh`（见上文），它会直接告诉你是哪一层的问题。
2. 日志里出现「未找到 termux-notification 命令」→ 执行 `pkg install termux-api`。
3. 日志里出现「Termux:API 应用未安装，通知已停用」→ 装上那个 APK，然后**重启 DSH**。
4. 也可能是 Termux 被系统冻结或杀掉了。给 Termux 和 Termux:API **关掉电池优化**，
   并在 Termux 的通知里打开 `acquire wakelock`。

**振动不生效**

- 确认「振动」不是 `0`；
- 默认的「振动方式」是 `termux-api`，它会调用 `termux-vibrate`，不经过通知渠道，
  比通知自带的 `--vibrate` 可靠得多（Android 8+ 上后者常被通知**渠道**设置忽略）；
- 如果当初改成了 `notification`，改回 `termux-api`；
- 检查系统里没有禁用 Termux:API 的振动权限；
- 「静音也振动」打开时会带 `-f`，系统静音/仅振动模式下也会振；
- 填的是 `500,1000,200` 这种 pattern 时只能走通知渠道（`termux-vibrate` 只接受单个毫秒数），
  检测页会说明这一点。

**通知一直赖在通知栏里不消失**

- 点过的通知由 Android 自动消失（Termux:API 设了 `autoCancel`）；
- **没点过的**会在你回到对话时被自动清掉：新一轮开始，或在浏览器里回答完提问 / 审批。
  想确认开关是否打开，看设置页的「回到对话时清空过时通知」，环境检测里也有「清空旧通知」一项；
- 想立刻手动清，点设置页的「清空旧通知」按钮；
- 如果你压根没回对话（只是切到别的 App 看了看），通知会留着 —— 那时它其实还没过期。

**悬浮通知不弹横幅**

按这个顺序排查（前两条最常见）：

1. **只有「需要你操作」的才弹横幅** —— 「任务完成」这类结果类**故意不弹**，免得打断你。
   想确认横幅是否正常，点设置页的「发一条测试通知」，它每次都用全新的通知 id，一定会弹。
2. **屏幕必须是亮的**。Android 在息屏、或免打扰模式下不弹横幅，通知只会进通知栏。
3. 检查系统里 Termux:API 的「悬浮通知 / 横幅通知 / 弹出通知」权限
   （不少国产 ROM 单独有这一项且默认关闭），以及是否处于勿扰模式。
4. 弹横幅由**通道重要性**决定。插件会建一个重要性 HIGH 的通道（默认 `dsh-heads-up`）。
   如果你（或系统）把这个通道的重要性调低过，**程序改不回来** —— Android 以用户设置为准。
   这时把设置页的「悬浮通道」改成新值（例如 `dsh-heads-up2`），插件就会建一个全新的 HIGH 通道。
5. 点一次设置页的「检测环境」：它每次都会重新断言一遍通道。

> 顺带说明一个已修的坑：Termux:API 把 `--id` 当通知 tag 用，**同一个 tag 重发是「更新」已有通知**，
> 而 Android 不会为更新弹横幅。所以「需要你操作」的通知每次都换一个新 tag
> （代价是这类通知不再互相覆盖，会在通知栏里各占一条）；结果类仍用固定 tag 覆盖上一条。

**语音的语速 / 音调和我在手机「文字转语音」里设置的不一样**

这是 Termux:API 的固定行为，不是插件改写你的设置。它每次播报都会调用：

```java
mTts.setPitch(...);                                          // 不传 -p 就是 1.0
mTts.setSpeechRate(intent.getFloatExtra("rate", 1.0f));       // 不传 -r 就是 1.0
```

也就是**无论你手机里配的是多少，它都会按参数重设一遍，缺省值就是 1.0** —— 于是你手机里的语速被盖掉了。
而那个值在 Termux 里读不到（`settings get secure tts_default_rate` 需要 `INTERACT_ACROSS_USERS` 权限），
插件没法自动跟随。

想和手机一致，就在设置页把「播报语速」「播报音调」填成手机里的同一个值即可。
手机上的语速滑块一般会显示倍率（例如 `1.0x` / `1.3x`），照着填就行。

**语音通知不出声**

先在 Termux 里手敲一次，这是最快的判断：

```bash
termux-tts-speak 测试
```

- **能出声** → 引擎没问题，去设置页确认「语音通知」是打开的（默认关闭）；
- **一直卡住不返回**（按 `Ctrl+C` 退出）→ TTS 引擎**被占住或排队堵住了**。常见于短时间内反复触发播报、
  或上一次被强杀后残留了等待中的请求；**重启 Termux（或重开 Termux 会话）即可恢复**，实测恢复正常后
  4 个字约 2.7 秒。插件侧也做了防护：超时按文本长度自适应（20–90 秒），卡住时会被杀掉且不会留下挂起进程；
  上一条还在念时会跳过新的而不是排队；连续失败到阈值后本次运行**自动停止播报**并在日志里说明；
- **报错** → 去上面那个系统设置里安装 / 选择一个引擎，再跑 `termux-tts-engines` 应输出 JSON；
- 播报走 `NOTIFICATION` 音频流，所以**系统静音时通常不出声** —— 这是 Android 的行为，不是插件问题；
- 「播报语言」填了引擎不支持的语言时可能不出声，留空让引擎自选即可。

> 另外：上一条还在念的时候来了新通知，插件会**跳过**这次的播报而不是排队 ——
> 通知是即时提醒，排队念一串过期消息没有意义。

**点通知没有打开浏览器**

- 检查「点击通知打开」是否被清空了（留空会改为打开 Termux 应用）；
- 确认地址和 DSH 实际监听的地址一致（默认 `http://127.0.0.1:3080/`）；
- 确认 `termux-open-url` 可用（它随 `termux-tools` 提供，检测页会检查）。

**看不到「Termux 通知」这一页**

- 确认装完之后**重启过 DSH**（profile 的 `patchReload` 是 `startup`）；
- 跑一次 `scripts/check-integration.sh`，它会指出是 profile 组合、宿主半侧还是客户端 bundle 的问题；
- 它是设置左侧导航里独立的一页，不在「插件」分区里。

**想先确认接线对不对，但不想被通知打扰**

把「只写日志（dry-run）」打开，然后提问一次或跑完一轮，日志里会出现
`[dry-run] 【需操作】❓ 需要选择 :: … :: 语音「需要你选择，…」` 这样的记录。

---

## 卸载

```bash
node "$HOME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web remove dsh-termux-notify
```

然后检查 `$HOME/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里是否还留着
`dsh-termux-notify` —— 有的话删掉那一行。最后重启 DSH。

如果之前在设置页里改过值，可以顺手删掉 `$HOME/.dsh/settings.yaml` 里的 `termux-notify:` 段。

---

## 工作原理（给好奇的人）

插件挂三个**只读旁路**观测点，不改变 DSH 原有行为：

| 观测点 | 类型 | 用途 |
| --- | --- | --- |
| `user-questions/request` | Cordis waterfall | 需要人类回答（提问、计划审阅） |
| `approval/request` | Cordis waterfall | 敏感操作的一次性授权 |
| `session/event` 的 `turn/end` | 事件流 | 一轮结束、结果出现 |

两个 waterfall 监听器都是「先发通知，再 `next()` 委托」，所以下游的回答者/审批者行为完全不变；
通知全部 fire-and-forget，异常只写日志，永远不会影响 agent 运行。

几个实现上的选择：

- **必须 `prepend`**：Cordis 的 waterfall 里不调用 `next()` 就等于否决整条链。若追加在末尾，
  就要等真正的回答者（Web 前端）先交出结果 —— 也就是用户**已经答完**才轮到发通知，通知就失去意义了。
- **启动探测 + 硬超时**：Termux:API 应用缺失时 `termux-notification` 会一直挂起等待广播回应，
  所以启动时先探测、缺失就停用；真发时用 `spawn` + `detached` 起子进程，超时对整个**进程组**发 `SIGKILL`
  （只杀直接子进程会留下挂起的广播进程）。
- **振动走 `termux-vibrate`**：直接调用系统 Vibrator 服务，不经过通知渠道，
  绕开 Android 8+ 上「渠道设置把 `--vibrate` 吃掉」这个常见问题。
- **悬浮通知要绕一层**：Android 8+ 上「弹不弹横幅」由**通道重要性**决定，而不是 `--priority`。
  Termux:API 建通道时从 intent 的 `priority` extra 读重要性，但随包的 `termux-notification-channel`
  包装脚本**不传**这个 extra（建出来是 DEFAULT，不弹横幅），所以插件直接调底层的
  `libexec/termux-api NotificationChannel ... --es priority high` 来建通道。
  另一个坑：给 `--channel` 传一个**不存在的通道 id，通知会被系统直接丢弃** ——
  因此插件先确认通道建好，建不成就退回默认通道，绝不引用不确定存在的通道。
- **清空旧通知**：`termux-notification-remove <tag>` 就是 `manager.cancel(tag, 0)`，没有批量接口，
  所以插件**记下自己发过的每个 tag**（含悬浮通知用的全新 tag），再在「用户明显回到对话里」时逐个撤销：
  根会话的 `turn/start`、`user-questions/request` 落定、`approval/request` 落定。
  后面两个触发点是必须的 —— **在浏览器里回答提问时那一轮不会重启**，只看 `turn/start` 的话，
  那条「需要你选择」会一直赖在通知栏里。
  清空会先等「在途的发送」落定，否则「刚发出就被回答」会因为 tag 还没登记而漏掉那一条；
  子 agent 会话的轮次很频繁，因此不触发（否则主会话的提醒会被子会话清掉）。
- **语速/音调必须显式传**：Termux:API 每次都会 `setSpeechRate`/`setPitch`，缺省 1.0，
  所以「不传」不是「跟随系统」而是静默变成 1.0；插件显式传 `-r`/`-p`，让它由设置项决定。
- **语音通知**：`termux-tts-speak` 会**阻塞到播完**才返回，所以它的超时按文本长度自适应
  （30–90 秒），不能沿用通知的 8 秒超时，否则长句会被念到一半杀掉；上一条还在念时跳过新的，
  避免排队念一串过期消息。
- **通知 tag 与横幅**：Termux:API 的 `--id` 是通知 **tag**（`notify(tag, 0, ...)`），同 tag 重发是「更新」，
  而 Android 不为更新弹横幅。所以需要横幅的通知每次用新 tag。同理，这类通知**不传 `--group`** ——
  通知分组在不少 ROM 上也会抑制横幅。
- **优先级分层**：`--priority` 由场景决定（需要操作的用配置值，结果类固定 `default`），
  这样「任务完成」不会用横幅打断你。
- **设置页**：宿主用 `ctx.settings.installSection()` 注册运行时命名空间，浏览器半侧往
  `settings.section` 槽注册一页，两者 key 相同才会渲染出来。改动经 settings 服务持久化到
  `settings.yaml`，因此不重启就能生效。

## 开发与测试

仓库里的客户端 bundle 是手写的（`window.__ModuleLoader__.load` + CJS 风格 `require`），
**不需要 tsdown/vite 构建**，改完刷新页面即可。

```bash
git clone https://github.com/xs2966/dsh-termux-notify
cd dsh-termux-notify

npm test          # 三套一起跑
node test/run.mjs         # 56 项宿主：配置、场景内容、工具名映射、argv 组装、节流、停用、真实超时与进程组清理、悬浮通道与 tag、语音播报、环境检测
node test/integration.mjs # 用真实 cordis 加载插件，验证 waterfall 委托与 agent scope 派发
node test/client.mjs      # 假浏览器 + 迷你 React 加载 client bundle，验证设置页渲染与写入
```

`test/integration.mjs` 需要 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-scope`，
所以测试只在**仓库里**跑得起来（安装副本不含 `test/`，由 `scripts/check-integration.sh` 自动跳过）。
其中有一项会真的起一个 `sleep 30` 子进程，验证超时兜底确实杀掉了整个进程组；
悬浮通知的用例还专门覆盖了「通道建不成时绝不引用它」（引用不存在的通道会让通知被系统丢弃）。

## 许可

MIT
