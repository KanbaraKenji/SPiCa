# Agent 内核设计（`@spica/core`）

> 状态：M1–M3 已完成（2026-11-09）。M1：主循环、两种接入、事件流、可追溯记录、文件工具；M2：钩子六位置、会话树与回传、两种插话、确认与提问卡、限流与花费上限；M3：run_command、web_fetch、web_search、MCP 客户端、wso2、sqlite 存储与重启恢复。下一步 M4「项目与三层团队」、M5「后端接口（MCP 服务）」。
> 需求来源：立项书「定位」「硬规则」「模型接入」「Harness」「数据与外壳」「首版验收」；主循环纯自写（不试接 Pi）。

## 1. 总览与架构图

- 内核是一个纯 Node 包，不依赖任何 Agent 框架、不依赖 Electron API；桌面端主进程、MCP 服务、测试都是它的调用方。
- 对外只有两样东西：**接口**（`Runtime` 上的方法：开会话、发消息、插话、答复确认、导出记录……）和**事件流**（类型化事件，界面和 MCP 服务只消费事件）。
- 运行时零依赖：`fetch`、`node:sqlite`、`fs.promises.glob` 都是 Node 自带；SSE 解析自己写。这样 WSO2 的 401 重取和「收到响应后改响应」都在我们自己的 fetch 层里做。
- 为什么不用 Anthropic 官方 SDK：要自己掌握 fetch 层（WSO2 的 401 重取、收到响应后改响应、所有会话共用的限流器），而且三种接入要走同一套重试和记录；所以三种 provider 都直接发 HTTP。
- 类型放在 `@spica/protocol`（单文件、无依赖），内核、桌面外壳、将来的 MCP 服务共用一份定义。

```
 调用方：桌面主进程 / MCP 服务 / 测试
        │  命令（AgentApi）            ▲ 事件流（CoreEvent）
        ▼                             │
 ┌───────────────────────── Runtime ─────────────────────────┐
 │ 会话树  HookRegistry  ToolRegistry  CostLedger  Tracer     │
 │ RateLimiter（每个模型端点一个，所有会话共用）  Store        │
 │                                                            │
 │   Session（顶层）──► Session（项目经理）──► Session（子 Agent）│
 │      每个 Session 自己跑主循环：段组装 → 钩子 → 调模型 → 工具 │
 └──────────────┬─────────────────────────────────────────────┘
                ▼
     Provider：openai-compatible │ anthropic │ wso2（M3）
                ▼  共用 http 层：重试退避、超时、取消、401 重取一次
            模型网关 / 厂商接口
```

## 2. 主循环

- 一轮：组装上下文 → 发请求前钩子 → 经限流器调模型（流式）→ 收到响应后钩子 → 解析文本与工具调用 → 工具调用前钩子（可拦 / 改 / 要确认）→ 并行执行工具 → 工具结果后钩子 → 结果写回历史 → 下一轮。
- 停止条件：没有工具调用；轮数上限；花费上限；用户中止；等确认 / 等回答（暂停，不算结束）。
- 每轮边界检查插话队列；「立刻打断」走 abort → 塞入 → 继续。
- 一次「运行」（run）= 从一条用户输入开始，到模型不再调工具为止；一次「轮」（turn）= 一次模型调用加它带出的工具调用。
- 工具并行执行（最多 8 个同时），结果按调用顺序放进**同一条** tool_results 消息。工具出错、不存在、参数不合法都作为错误结果交回模型，不中断运行。
- 模型调用出错（重试用完、400 等）：运行以 `error` 结束，留一条可追溯记录，会话可以继续发消息。
- 内部消息格式是我们自己的，不是任何一家的线格式：消息由内容块组成（text / thinking / tool_use / tool_result），助手消息另带一个不透明的 `providerExtras`，供某些接口要求「下一轮原样带回」的字段用（按接口选项处理，不按模型名分支）。

## 3. 上下文「段」怎么组装

- 一次请求由四段按序拼成：**系统提示 → 历史 → 用户输入 → 本次运行的工作区**（代码 `src/context.ts`）。
  - 用户输入 = 最后一条 `kind: user` 的消息（用户或父会话写的）及紧跟其后的用户侧消息；它之前是历史，之后是工作区（本次运行的助手回复、工具结果、插话、回传备注）。
  - 段只按已存的消息算出来，不另存状态，所以重启后算出的段和崩溃前一样。
- 六个相对位置：`system:before`、`system:after`、`history:before`、`history:after`、`input:before`、`input:after`。插件的注入物声明位置、优先级和来源，组装时按位置归位、同位置按优先级排序。
- 注入落到哪种消息上：`system:*` 并进系统提示文本；`history:*` 和 `input:*` 变成带标记的用户侧消息（模型看得见是注入，界面可以折叠）。注入不写进持久历史，每轮重新算（所以「外部数据每次重查」成立）。
- 组装结果先以「段」的形式交给发请求前钩子，钩子改完再由 provider 转成线格式。

## 4. 事件类型

- 定义在 `@spica/protocol` 的 `CoreEvent`。统一信封：`{ seq, at, sessionId, parentChain, type, ... }`，`seq` 全局单调递增，方便断线重放；`parentChain` 让界面不查表就能把事件挂到团队树上。
- 类型（26 种）：

| 分组 | 事件 |
|---|---|
| 状态 | `status`（idle / queued / thinking / tool / awaiting_confirm / awaiting_answer / done / error / aborted / interrupted）、`queue`（排队位次） |
| 流式 | `text.delta`、`thinking.delta`、`tool.call`（模型开始写某个工具调用） |
| 消息 | `message`（一条完整消息入库，界面以它为准）、`message.replaced`（钩子改了已流出的回复） |
| 工具 | `tool.start`、`tool.end`（带结果开头、耗时） |
| 等用户 | `confirm.request` / `confirm.resolved`、`ask.request` / `ask.resolved` |
| 花费 | `usage`（单次调用）、`cost`（运行 / 会话 / 全局累计，过警戒线带 warning）、`budget.stop` |
| 记录 | `trace`（一条可追溯记录写完） |
| 插话 | `steer.queued`、`steer.applied` |
| 会话树 | `child.spawned`、`child.report`、`relay` |
| 边界 | `turn.start`、`turn.end`、`run.end`（completed / max_turns / budget / aborted / error / awaiting_*）、`error` |

- 全部已接上，只差 `interrupted` 状态（M3 重启恢复时用）。`steer.applied` 只列真正的用户插话，不含回传和回报备注。

## 5. 模型接入（provider）

- 统一接口：`stream(request, ctx) → AsyncIterable<ProviderEvent>`（`text` / `thinking` / `tool_call` 增量，最后一个 `response`）；`request.maxTokens` 必填。
- `openai-compatible`（`src/providers/openai.ts`）：/chat/completions + SSE；`tool_calls` 按 index 拼增量，id 只在第一段出现；`stream_options.include_usage` 取 usage（缓存命中数兼容两种常见字段名）；baseUrl / headers / 路径 / max-tokens 字段名 / 请求体默认字段都可配。
  - 有的接口把推理文本放在单独的增量字段里，并要求带工具调用的那一轮把它原样带回：做成选项 `reasoning: { field, echo: never | tool_turns | always }`，默认字段 `reasoning_content`、`tool_turns`。只带回同一个 provider 产生的推理。
  - 工具参数 JSON 坏了不抛错，原样交给工具层，由它把「参数不是合法 JSON」作为错误结果回给模型。
- `anthropic`（`src/providers/anthropic.ts`）：Messages API 原生流式；`input_json_delta` 拼工具参数；thinking 块连同 signature 只回传给产生它的 provider；system、工具表最后一项、最后一条消息打 `cache_control`（实测第二轮命中缓存）；同角色连续消息合并、tool_result 排在用户轮最前；模型托管的块（如托管搜索结果）作为 `opaque` 块原样保存，只回传给同一 provider。
- `wso2`（`src/providers/wso2.ts`）：openai-compatible 外包一层 OAuth2 client credentials（`OAuthClientCredentials` 作为 `AuthSource`）。token 流程：
  1. 第一次请求前向 token 端点 POST `grant_type=client_credentials`（client id/secret 默认走 HTTP Basic，也可放表单；scope 可配），拿 `access_token` 和 `expires_in`；
  2. 缓存到过期前 60 秒（可配），之后的请求带 `Authorization: Bearer`；同时多个会话要 token 只发一次请求；
  3. 网关回 401：作废缓存、重取一次、重发一次（不占重试次数）；再失败就报错；
  4. 凭据被拒（401/400）不重试，报「token request rejected (HTTP 401)；check client id, secret and scope」，错误里不出现 secret；
  5. 每次取 token 记一条 `kind: 'auth'` 的可追溯记录（目标默认是 `<provider id>:token`）。
  - 假网关（`src/testing/fake-gateway.ts`）模拟了 `/oauth2/token`、token 过期（`expireTokens()`）和错误凭据，六条测试覆盖。
  - 价格：wso2 没有单独价表时按兜底价（输入 10、输出 50 USD/百万 token，故意偏高）算，绝不按 0 算。
- 共享层（`src/providers/http.ts`）：408 / 409 / 429 / 5xx / 网络错重试，指数退避加抖动，尊重 Retry-After；只在拿到响应头之前重试（流已开始吐字就不重试，免得界面上出现重复文字）；等响应头有超时，读流有空闲超时；AbortSignal 贯穿到读流；错误信息过一遍脱敏。
- 限流器（`src/limiter.ts`）：每个 provider 一个，并发数 + 每分钟请求数，按部署配置，所有会话共用；排队时发 `queue` 事件和 `queued` 状态。一次模型调用（含它内部的重试）占一个名额。

## 6. 钩子

代码 `src/hooks.ts`。一个插件注册一组钩子，带来源（插件 id）和优先级（小的先跑）：

| 钩子 | 拿到什么 | 能做什么 |
|---|---|---|
| `inject` | 会话信息、运行 id、第几轮 | 返回注入物，指定六个位置之一和同位置内的优先级；每轮重算，不进持久历史 |
| `beforeRequest` | 完整的段、工具表、模型参数（provider、model、maxTokens、temperature、托管搜索开关、请求体附加字段） | 改、增、删，返回新的草稿 |
| `afterResponse` | 完整响应（文本、思考、工具调用、用量） | 改；改了以后会话发 `message.replaced`，界面以入库的那条为准 |
| `beforeTool` | 调用 id、工具名、参数、是否不可逆 | `allow`（可改参数）/ `deny`（附理由，作为错误结果回给模型）/ `confirm`（要用户确认）/ `auto`（不可逆工具也免确认） |
| `afterTool` | 调用和结果 | 改结果文本和是否出错 |

- 多个插件的 `beforeTool` 合并规则：任一 deny 就拦；否则任一 confirm 就要确认；不可逆工具默认要确认，除非有插件给 `auto`。
- 「收到响应后改」的做法：文本照常逐字流给界面，响应完整后再交钩子；钩子改过就发 `message.replaced`。这样不牺牲逐字流出。
- `runtime.unregisterSource(id)` 一次撤掉该来源的全部钩子和工具（测试覆盖：撤掉后下一次请求里注入和工具都没了，别的插件不受影响）。

## 7. 内置工具与确认

- 内置：read_file、write_file、edit_file、list_dir、glob、grep、run_command、web_fetch、web_search（配了搜索接口才有）、ask_user、suggest_actions，加会话树工具 spawn_agent / message_agent / wait_agents / record_decision。子会话默认继承父会话的工具白名单。
- read_file 带行号、可按行分页，二进制文件没有提取器时报错；edit_file 按原文替换、要求唯一（或 replace_all），CRLF 文件接受 LF 参数；glob / grep 跳过 node_modules 和版本库目录，grep 用 JS 正则、纯 JS 实现，不依赖外部程序。
- 结果第一行统一是 `[fetched at 2026-11-09T15:20:42.988+08:00]`（本地时间带时区），系统提示告诉模型旧结果可能过期；不缓存外部数据。
- 工具输入先按 JSON schema 粗校验（必填、基本类型），不合格直接回错误结果。
- 工具声明带 `irreversible`；带标记的默认走确认，插件可配成自动（钩子返回 `auto`），也可以给普通工具加确认。
- 确认与提问卡的流程：同一轮里要确认的调用挂起，其余调用照常执行，结果先存进 `tool_calls` 表；会话状态转 `awaiting_confirm` / `awaiting_answer`，发 `confirm.request` / `ask.request`，本次运行结束（`run.end` 的原因写明在等什么）。用户 `confirm(callId, true/false)` 或 `answer(callId, 文字)` 后，全部挂起项都有了结果，就把这一轮所有结果按调用顺序合成一条 tool_results 消息，开始新的运行。拒绝的动作不执行，作为错误结果告诉模型「用户拒绝了，别重试」。
- 因为挂起状态全在存储里（`pending` + `tool_calls`），不依赖内存里的 Promise，M3 接上 sqlite 后重启也能续上。
- **read_file 与提取器**：扩展名匹配到提取器时，把 `{pages, sheet, offset, limit, maxChars}` 交给它。提取器返回字符串时按文本文件处理（按行编号分页）；返回 `ExtractResult {text, meta, truncated}` 时原样透传，只加取数时间和一行头。每次读文件都发 `file.card` 事件（`FileCardMeta`：路径、类型、大小、修改时间、读了哪几页 / 哪张表 / 哪些行、是否截断、扫描版、编码），文本文件也发。PDF / Word / Excel 的提取器由「文件读取」话题的 `@spica/extract` 提供。
- **run_command**：Windows 走 PowerShell（`-EncodedCommand`，先把输出编码设成 UTF-8，透传原生命令的退出码），其他系统走 sh；`windowsHide: true` 不弹窗；默认超时 120 秒、最长 600 秒；超时或用户插话时用 `taskkill /T /F` 杀掉整棵进程树；输出超过 3 万字符时全文落盘（默认临时目录，可配 `spillDir`），只回开头和结尾并告诉模型文件路径。**默认要确认**（标了 irreversible）：一条命令可能发邮件、改外部系统；插件可以配成自动。
- **web_fetch**：只收 http / https，内网地址照常放行（访问内网站点正是用途）；最多 5 次跳转、30 秒超时、最多下 5 MB；HTML 转纯文本（去脚本样式，保留标题、列表、链接）；二进制不显示；记 `kind: 'fetch'` 记录（目标是被抓的主机名，带字节数）。
- **web_search**：接口可插（`SearchBackend`），内核自带一个通用的「GET 返回 JSON」适配器（`jsonSearchBackend`：URL 模板、结果数组路径、字段映射）。没配搜索接口时不出现；会话用的模型自带托管搜索（如 Anthropic）且开着时也不出现，改用托管搜索。记 `kind: 'search'` 记录。
- **suggest_actions**：模型给出几个「下一步」按钮，发 `suggest.actions` 事件，不等用户选；用户点哪个，外壳就把它的 prompt 当用户消息发进会话。
- **MCP 客户端**（`src/mcp/client.ts`，stdio）：起进程（windowsHide）→ initialize → notifications/initialized → tools/list（支持翻页）→ tools/call；中断时发 `notifications/cancelled`；工具名 `<server>__<tool>`；服务端标了 destructiveHint 的工具默认要确认；工具挂在来源 `mcp:<name>` 或插件给的来源下，`unregisterSource` 一并停掉进程；`onExit`（是否意料之中、退出码、stderr 末尾）和 `stderrLog` 给插件做重启和日志；`Runtime.close()` 停掉所有 server。记 `kind: 'mcp'` 记录。HTTP 传输以后再加。

## 8. 会话树与回传

- 会话有 `id`、`parentId`、角色（top / manager / worker），各自有上下文、状态、花费；事件和可追溯记录都带父链。
- 父会话用工具管子会话（`src/tools/agent-tools.ts`）：
  - `spawn_agent {title, task}`：开子会话并把任务作为「父会话写的」第一条消息发过去，立即返回 id，多个子会话并行跑（受同一个限流器约束）。
  - `message_agent {id, text}`：给自己的子会话发话；子会话在跑就在下一轮边界生效。只能发给自己的孩子。
  - `wait_agents {ids?, timeout_seconds?}`：等子会话跑完，把各自的回报作为工具结果返回；被插话打断时立刻返回。
  - `record_decision {decision}`：子会话里模型把「用户改了的决定」记下来。界面或接口也能直接调 `runtime.recordDecision(会话, 内容, 'user')`。
- 回传（默认设计）：
  - 用户在子会话里写的**每一条**消息，原样作为备注追加进父会话：`[From sub-agent "标题" (id)] The user wrote in that session: "原话"`。
  - 决定变更同样追加，`meta.decision = true`，界面可以高亮。
  - 子会话一次运行正常结束，最后一段回答就是它的回报：发 `child.report`；父会话正卡在 `wait_agents` 等它时，回报走工具结果，不再重复追加备注；否则作为 `report` 备注进父会话历史，父会话下次运行时看得到。
  - 父会话正在跑时，备注排进队列，在下一轮边界写入，不会插进一对工具调用和工具结果中间。
  - 所有回传都写进存储的 `relays` 表（父、子、种类、原文、时间），将来做成员记忆和审计用。
  - 回传只走一层：项目经理收到的子会话备注不会再往顶层转；顶层要看就看项目经理自己的消息（父会话「知道」的范围由它自己决定写不写进回报）。
- 子 Agent 跑完一次状态变 `done`；用户再进去说话，它会再跑，并再回报一次。
- 子会话比父会话先跑完（父还没调 `wait_agents`）：回报已作为备注进了父会话，之后 `wait_agents` 只写「回报已在上下文里」，不重复贴全文。
- 父会话被 `abort()`：只停父会话自己，子会话继续跑完并照常回报（备注留在父会话历史里）；要连子会话一起停，界面逐个停或以后加「停全队」接口。
- 给常驻成员留口：会话带可选的角色模板、长期记忆接口、专属工具表；首版不实现，接口不堵死。

## 9. 运行中插话

- `steer(text, 'next')`（默认，运行中 `send` 也走它）：消息进队列，在下一轮开头按到达顺序写入；如果这时模型刚好答完、没有工具调用，也会为它多跑一轮，不会被吞。
- `steer(text, 'interrupt')`：中止当前这一轮（模型流或正在跑的工具），已流出的半段文字作为一条 `meta.interrupted = true` 的助手消息保存；正在跑的工具拿到中止信号，返回「被用户打断」的错误结果（工具调用和结果始终成对）；然后写入插话、继续下一轮。被中止的那次调用记一条 `aborted` 的可追溯记录。
- 运行中的会话 `abort()`：整次运行停下，状态 `aborted`，会话仍可再发消息。
- 等确认 / 等回答时发来的消息排队，答复后随下一次运行写入。
- 测试（`src/steer.test.ts`）：工具执行中连发三条（顺序、无丢失、第二次请求里三条都在工具结果之后）；最后一轮模型调用中到达的插话；打断模型流；打断工具；连续两次打断；中止后再用。
- 已知缺口：排队中、尚未写入的插话目前只在内存里，进程被强杀会丢；M3 做存储时一起持久化。

## 10. 可追溯记录与花费

- 每次对外请求一条 `TraceRecord`：开始时间、耗时、kind（model / search / fetch / mcp / auth）、会话 id、父链、发起者（model / tool:名字 / plugin:id / runtime）、目标（默认是 provider id；部署时设 `traceHost: true` 才记主机名，从不记完整地址）、模型、token（含缓存读写）或字节、花费估算、状态、HTTP 状态、尝试次数、脱敏后的错误。**不记请求头和正文**。
- 价表是数据（`src/cost.ts`，按 provider id 或种类、模型查，`*` 兜底，可整体覆盖）。Claude 的价格按官方表；DeepSeek 两个模型的价格是占位，标 `unverified`，待核实（不影响上限生效，只影响估算准不准）。
- 上限：全局、单会话、单次运行、单次调用，外加按 provider 单独设。策略是**不开始一次可能越线的调用**：按「估算输入 + maxTokens 全用完」算最坏花费，超了就停（`budget.stop` 事件写明花了多少、上限多少）。超过警戒线（默认 80%）的累计在 `cost` 事件里带 warning。
- 输入估算取「按字符估」和「这个会话上一次调用的真实输入 token 数」中较大的那个（同一会话上下文只会变长），避免按字符低估导致越线。
- 开发配置（冒烟脚本里）：Anthropic 全局 100 USD、单次 2 USD，单次运行 1 USD。重启后的累计从存储里的记录回填（M3）。
- 限流测试：并发上限 1 时三个会话同时发，网关同时只见到 1 个请求，排队的会话收到位次 2、1 和 `queued` 状态；每分钟请求数用假时钟测滑动窗口；排队中取消不卡住后面的人。
- 导出 JSONL。

## 11. 存储与恢复

- `Store` 接口两份实现：`MemoryStore`（测试）和 `SqliteStore`（`node:sqlite`，Node 24 自带、不用本机编译，所以 Electron 主进程里也能用；WAL 模式）。
- 表：`sessions`（id、parent_id、role、title、status、config、created_at）、`messages`（id、session_id、seq、role、content_json、meta_json）、`tool_calls`（id、session_id、message_id、name、args、result、status、started_at、ended_at；同一轮里已执行的工具结果存在这里，所以等确认时重启也不丢）、`pending`（等确认 / 等回答：session_id、call_id、message_id、item_json）、`traces`（每次对外请求一行）、`relays`（子→父回传）。
  另有 `queued`（排队中的插话和回传备注，按到达顺序）、`meta`（库结构版本）。`tool_calls` 的主键是（会话、助手消息、调用 id），因为有的网关会在不同轮次重复用 `call_0` 这样的 id。
- 流式中的回答约每秒存一次（第一段立即存），标 `meta.partial`；正常结束时就地改成完整消息。
- `Runtime.restore()`（重开时调用）：
  - 读回会话树、消息、回传；
  - 有挂起项的会话恢复成「等确认 / 等回答」，答复后从断点继续；
  - 停在 thinking / tool / queued 的会话标成 `interrupted`，`session.resume()`（或接口 `resume`）续跑：没有结果的工具调用补一条「上次运行在这个工具结束前停了」的错误结果，再写入排队中的插话，然后调模型；
  - 存了一半的回答标成 `interrupted`，界面显示「中断」，模型下一轮也看得到这半段；
  - 花费累计和「上一次真实输入 token 数」从记录回填，上限在重启后照样生效。
- 正常关闭 `Runtime.close()`：正在跑的会话停下并标成 `interrupted`（不是 aborted），重开可续；MCP server 一并停掉。
- 测试：正常关闭后续跑、提问卡跨重启、会话树与回传跨重启；**强杀**用子进程真杀：一次停在工具里（带一条排队插话），一次停在流式一半，重开后都能看到原样记录并续跑。

## 12. 给常驻成员和评测插件留的口

- 常驻成员：角色模板、记忆接口（读写由插件实现）、专属工具表三个可选字段；可追溯记录完整可导出，将来做成员记忆用。
- 评测插件：只走公开接口和事件流（与 MCP 服务同一套），不碰内核内部。

## 13. 未决问题

- 「收到响应后改响应」与逐字流出的矛盾：默认先流给界面、响应完整后再交钩子；钩子若改了内容，发一个 `message.replaced` 事件让界面替换。是否需要「缓冲模式」由插件声明。
- 价表默认值未核实，需对照各家公开价格。
- web_search 非 Anthropic 时接哪家搜索接口，待定（接口可插，通用 JSON 适配器已有）。
- **Node 24.15 在 Windows 上中止 HTTP 流时偶发硬崩溃**（退出码 0xC0000409，无 JS 栈、无崩溃报告）。纯 `fetch` 和 `node:http` 都能复现，不经过 Spica 代码；进程里没有第三方 DLL。压力测试大约每几千次中止崩一次；全量测试在安静的机器上约 10 次里有 1 次某个测试进程这样退出（从没有断言失败）。产品影响：一次插话或报错 = 一次中止，平时概率很低，但内核跑在 Electron 主进程里时会把整个桌面端带走。复现脚本和用法在 `packages/core/scripts/diag/`。待定：内核要不要放进独立进程（Electron utilityProcess，崩了由主进程拉起，靠 `restore()` 接着干）；Electron 45 自带的 Node 上是否还会出现。
- 冒烟里观察到：项目经理收到「用户在子会话里改方向」的回传后，有时会判断这只是对那个子任务的要求，不套用到总体结论，并会问用户。回传本身没丢；要不要在系统提示里规定「子会话里用户的改动优先」，看他的意思。

## 14. 验收记录

| 里程碑 | 日期 | 测试 | 真模型冒烟 |
|---|---|---|---|
| M3 | 2026-11-09 | 15 个测试文件 112 条全过（新增：sqlite 存储、正常关闭 / 提问卡 / 会话树跨重启、两种强杀、wso2 token 流程、run_command、web_fetch / web_search、MCP 客户端、文件卡、提取器请求） | DeepSeek flash：读文件→grep→答对，2 次调用约 0.0005 USD；团队冒烟仍通过（9 次调用约 0.004 USD） |
| M2 | 2026-11-09 | 10 个测试文件 72 条全过（新增：钩子六位置与撤销、两种插话、确认与提问卡、会话树与回传、限流与花费上限、AgentApi 适配） | DeepSeek flash 团队冒烟（`npm run smoke:team -w @spica/core`）：项目经理并行开两个子 Agent 各读一份报价，用户中途进 B 改方向「只看付款和认证」，回传到项目经理，项目经理的结论明确按这次改动写；9 次调用约 0.004 USD |
| M1 | 2026-11-09 | 5 个测试文件 40 条全过（流式解析、两种 provider 往返、重试 / 不重试 / 中止、文件工具、读文件→grep→回答整条循环、父链） | DeepSeek flash：read_file + grep 并行 → 正确回答，2 次调用约 0.0006 USD；Haiku 5.5：同样通过，2 次调用约 0.0004 USD，第二次命中缓存 1491 token |
