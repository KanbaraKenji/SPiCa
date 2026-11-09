# Agent 内核设计（`@spica/core`）

> 状态：M1–M5 内核部分已完成（2026-11-09）。M5：后端进程入口（utilityProcess）、端口协议与客户端、单写者锁、扩展模块（attachBackend）、本程序的 MCP 服务（stdio）、测试连接探针。J2–J7 都能经 MCP 服务自动跑：J2–J5、J7 在 `npm run journeys -w @spica/core`，J6 在插件包（`journey:j6`，751a20b）。还差：主进程监护代码（在 apps/desktop，归桌面外壳）、HTTP 传输（可选）。
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
- **工具被停用之后**（插件停用、MCP server 断开）：每轮按当时的工具表发请求，停用的工具不再提供。注册表记着哪些工具是被撤掉的；会话里以前用过、现在被撤掉的工具，下一轮开始前写一条运行时备注（`kind: 'note'`，`meta.author: 'runtime'`、`meta.toolsUnavailable: [名字]`，正文给模型看：这些工具已停用，别再调，需要就告诉用户），同一批只说一次。模型照旧调了，结果是「这个工具已不可用，什么都没执行」，调用记录状态 `unavailable`；MCP 服务 `spica_run` / `spica_wait` 的 `toolCalls` 只列真执行了的，这类调用另列在 `unavailableToolCalls`。外壳显示这条备注时按 `meta.toolsUnavailable` 自己写文案，不显示正文。
- 工具声明带 `irreversible`；带标记的默认走确认，插件可配成自动（钩子返回 `auto`），也可以给普通工具加确认。
- 确认与提问卡的流程：同一轮里要确认的调用挂起，其余调用照常执行，结果先存进 `tool_calls` 表；会话状态转 `awaiting_confirm` / `awaiting_answer`，发 `confirm.request` / `ask.request`，本次运行结束（`run.end` 的原因写明在等什么）。用户 `confirm(callId, true/false)` 或 `answer(callId, 文字)` 后，全部挂起项都有了结果，就把这一轮所有结果按调用顺序合成一条 tool_results 消息，开始新的运行。拒绝的动作不执行，作为错误结果告诉模型「用户拒绝了，别重试」。
- 因为挂起状态全在存储里（`pending` + `tool_calls`），不依赖内存里的 Promise，M3 接上 sqlite 后重启也能续上。
- **read_file 与提取器**：扩展名匹配到提取器时，把 `{pages, sheet, offset, limit, maxChars}` 交给它。提取器返回字符串时按文本文件处理（按行编号分页）；返回 `ExtractResult {text, meta, truncated}` 时原样透传，只加取数时间和一行头。每次读文件都发 `file.card` 事件（`FileCardMeta`：路径、类型、大小、修改时间、读了哪几页 / 哪张表 / 哪些行、是否截断、扫描版、编码），文本文件也发。PDF / Word / Excel 的提取器由「文件读取」话题的 `@spica/extract` 提供。
- **run_command**：Windows 走 PowerShell（`-EncodedCommand`，先把输出编码设成 UTF-8，透传原生命令的退出码），其他系统走 sh；`windowsHide: true` 不弹窗；默认超时 120 秒、最长 600 秒；超时或用户插话时用 `taskkill /T /F` 杀掉整棵进程树；输出超过 3 万字符时全文落盘（默认临时目录，可配 `spillDir`），只回开头和结尾并告诉模型文件路径。**默认要确认**（标了 irreversible）：一条命令可能发邮件、改外部系统；插件可以配成自动。
- **web_fetch**：只收 http / https，内网地址照常放行（访问内网站点正是用途）；最多 5 次跳转、30 秒超时、最多下 5 MB；HTML 转纯文本（去脚本样式，保留标题、列表、链接）；二进制不显示；记 `kind: 'fetch'` 记录（目标是被抓的主机名，带字节数）。
- **web_search**：接口可插（`SearchBackend`），内核自带一个通用的「GET 返回 JSON」适配器（`jsonSearchBackend`：URL 模板、结果数组路径、字段映射）。没配搜索接口时不出现；会话用的模型自带托管搜索（如 Anthropic）且开着时也不出现，改用托管搜索。记 `kind: 'search'` 记录。
- **suggest_actions**：模型给出几个「下一步」按钮，发 `suggest.actions` 事件，不等用户选；用户点哪个，外壳就把它的 prompt 当用户消息发进会话。
- **MCP 客户端**（`src/mcp/client.ts`，stdio）：起进程（windowsHide）→ initialize → notifications/initialized → tools/list（支持翻页）→ tools/call；中断时发 `notifications/cancelled`；工具名 `<server>__<tool>`；服务端标了 destructiveHint 的工具默认要确认；工具挂在来源 `mcp:<name>` 或插件给的来源下，`unregisterSource` 一并停掉进程；`onExit`（是否意料之中、退出码、stderr 末尾）和 `stderrLog` 给插件做重启和日志；`Runtime.close()` 停掉所有 server。记 `kind: 'mcp'` 记录。（这是连别人的 MCP server 的客户端，只做 stdio；Spica 自己对外的 MCP 服务另有 HTTP 传输，见 12b 节。）

## 8. 会话树与回传

**会话模型：角色与线程**（统筹定）
- 「顶层」是一个**角色**，可以有多个对话线程。界面里的「新对话」就是再开一个顶层线程（没有父会话的会话自动套用 `top` 模板）。每个线程都看得到所有项目，靠的是 `list_projects` / `open_project` 等工具，不靠上下文。`getTopSession()` / `runtime.top()` 返回默认线程（最早的那个顶层线程；界面在左栏显示为「助理」，可以改名，名字由界面定，内核不起名）。
- 「项目经理」同理是一个角色：一个项目一个常驻线程，父会话是默认顶层线程。
- 任何顶层线程都可以给任何项目经理和它的子 Agent 发话（`message_agent`）、等它们（`wait_agents`）。项目经理的回报写进它的父会话（默认顶层线程）；别的顶层线程等它时，回报直接出现在 `wait_agents` 的结果里。
- 等子任务只用 `wait_agents`：内核自带的守卫会在弹确认卡之前拒绝只做 sleep 的命令（Start-Sleep、sleep、timeout ……），并提示用 `wait_agents`。

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
- **并行时的花费上限（M7）**：检查放在拿到限流名额之后，检查通过就把这次调用的最坏花费**预留**（`ledger.reserve`），记账时换成真实花费；调用出错、被停、被插话打断都释放预留。后面的调用检查时，已花的加上所有预留一起算，所以 16 个子任务同时起跑也不会一起冲过上限。只是因为预留占着才不够时（不算预留就够），这次调用不停，状态 `queued`（说明「等正在跑的调用记账」），等有预留释放再查一次；真不够了才 `budget.stop`。排队中的任务没有预留，被停时只让出排队位置。
- 输入估算取「按字符估」和「这个会话上一次调用的真实输入 token 数」中较大的那个（同一会话上下文只会变长），避免按字符低估导致越线。
- 开发配置（冒烟脚本里）：Anthropic 全局 100 USD、单次 2 USD，单次运行 1 USD。重启后的累计从存储里的记录回填（M3）。
- 限流测试：并发上限 1 时三个会话同时发，网关同时只见到 1 个请求，排队的会话收到位次 2、1 和 `queued` 状态；每分钟请求数用假时钟测滑动窗口；排队中取消不卡住后面的人。位次只在变化时发（同一位次不重复发）。
- 压力测试（`src/pressure.test.ts`，M7）：一个项目经理下 16 个子任务同时跑。并发上限 3：网关同时最多 3 个请求，按发起顺序服务；第 n 个排队的子任务先收到位次 n，再逐个收到 n-1 … 1，然后 queued → thinking；跑完限流器和预留都归零。全局上限 0.05 USD（不限并发、并发 4 各测一次）：总花费不超上限，等预留释放后放行的调用比只按最坏花费多（4 次 vs 2 次），其余每个都收到 `budget.stop`。排队中被停：让出位置、后面的人往前挪；运行中被停：预留释放，只有真跑完的那次记账。
- 导出 JSONL。

## 10a. 使用日志导出（M7）

把发生过的事整理成一份 JSON Lines，给评测插件用，将来也是「成员记忆」的原料。

- **入口**：`Runtime.exportUsageLog(filter)`；MCP 工具 `spica_export_usage_log {project_id?, from?, to?}`；命令行 `node packages/core/scripts/export-log.ts --db <spica.db> [--project <id>] [--from <ISO>] [--to <ISO>] [--config <backend.json>] [--out <文件>]`。命令行用只读方式打开数据库（`new SqliteStore(path, { readOnly: true })`，不改表、写入会报错），所以桌面端开着时也能导。
- **筛选**：`projectId` = 这个项目的项目经理、`config.projectId` 是它的会话，以及这些会话下面的所有子会话；它的项目动态和来信。`from` / `to` 含两端，ISO 8601，任意时区（按时间点比，不按字符串比）。会话按「创建 ≤ to 且最后更新 ≥ from」入选，其余记录按各自的时间。不筛项目时，另带不属于任何会话的请求记录（取 token、邮件轮询）。
- **去敏**（在序列化之前对每个字段的值做，避免转义后的 `"api_key": "…"` 漏网）：所有 provider 的 key、client secret、client id、端点地址和它的主机名。这些值由持有配置的一方登记进 runtime 的去敏表：`startBackend` 和设置页的 `applySettings` 调 `runtime.addRedactions(providerRedactions(配置))`，嵌入方用 `RuntimeOptions.redactions`。这张表只能往里写，没有读取接口，Provider 也不对外给出 key，所以拿到 runtime 的扩展模块读不到明文。provider 删掉后表里的值还留着，同一张表也用来清洗可追溯记录里的错误文字；看起来像密钥的串（`sk-…`、Bearer / Basic 后面的值、AWS / Google / GitHub / Slack 的 key 格式、JWT、私钥块、URL 里的 `用户:密码@`、`api_key= / password: / token= / secret=` 这类键值）；字段名本身是 `apiKey`、`password`、`token`、`authorization`、`cookie` 等的，值整个换掉。命令行另把名字里带 KEY / SECRET / TOKEN / PASSWORD / CREDENTIAL / BASE_URL / ENDPOINT 的环境变量的值和 `--config` 里的 key / 地址都当成要去掉的值，所以用 `--env-file=.env.local` 跑时，本机部署的 key 和地址也去掉，模型名（`SPICA_OPENAI_MODEL`）留着。**路径不带用户名**：临时文件夹换成 `%TEMP%`，本机用户文件夹和任何 `C:\Users\<名>` 换成 `%USERPROFILE%`，`/home/<名>`、`/Users/<名>` 换成 `$HOME`；两种斜杠、不分大小写，`C:\Users\Ann` 不会误伤 `C:\Users\Anna`（`hidePaths: false` 可关）。超过 2 万字符的文本截断并注明原长度。
- **格式**：第一行是 header，其余每行一条记录，`type` 区分。`schemaVersion` 只在字段含义变化或删字段时加一；新增字段不加版本，读的人要忽略不认识的字段。

| type | 字段 |
|---|---|
| `header` | `schema: "spica.usage-log"`、`schemaVersion: 1`、`exportedAt`、`filter {projectId, from, to}`、`counts {各 type: 条数}` |
| `session` | `id`、`parentId`、`role`（top / manager / worker）、`title`、`status`、`templateId`、`projectId`、`providerId`、`model`、`locale`、`createdAt`、`updatedAt`（不导系统提示词） |
| `message` | `id`、`sessionId`、`seq`、`role`、`kind`（user / assistant / tool_results / steer / relay / report / note）、`author`（user / parent / child / runtime / plugin / agent）、`createdAt`、`text`（文字块拼起来）、`content`（text / thinking / tool_use / tool_result 块；不含签名和 provider 私有块）、`meta`（文件卡、建议、回传来源、是否中断等，见 MessageMeta） |
| `tool_call` | `sessionId`、`messageId`、`id`、`name`、`input`、`status`（ok / error / denied / pending / unavailable）、`result`、`startedAt`、`endedAt`、`durationMs` |
| `trace` | TraceRecord 原样：`kind`（model / search / fetch / mcp / auth）、`startedAt`、`durationMs`、`sessionId`、`parentChain`、`initiator`、`target`（provider id 或主机名，从不是完整地址）、`model`、token 数、`costUsd`、`status`、`httpStatus`、`attempts`、`error` |
| `relay` | `id`、`parentId`、`childId`、`kind`（user_message / decision / report）、`text`、`createdAt` |
| `project` | ProjectInfo：`id`、`name`、`folder`、`managerSessionId`、`workflowId`、`stage`、`status`、`createdAt`、`updatedAt` |
| `project_log` | `id`、`projectId`、`sessionId`、`at`、`action`（file.write / file.edit / file.delete / command / child.spawn / child.report / decision / stage / mail / note）、`target`、`detail`、`summary`（按时间先后） |
| `mail` | MailItem：`id`（来源:邮件 id）、`sourceId`、`messageId`、`fromName`、`fromAddress`、`subject`、`receivedAt`、`preview`、`status`、`triage {result, projectId, by, reason}`、`feedback`、`routedTo`、`createdAt`、`updatedAt` |

- 测试（`src/export.test.ts`）：两个项目，项目 A 的项目经理带一个子会话、一次工具调用，消息里故意放了 provider key、网关地址、`sk-…`、Bearer、`"api_key": "…"`，项目动态里放 `token=…`，来信预览里放 `password: …`：全部导出后这些一个都不出现，其余文字保留；按项目 A 导只有 A 的两个会话、A 的项目和来信；时间段筛选按时间点；经 MCP 和命令行（应用开着数据库时）导出的条数一致。

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
- 评测插件：只走公开接口和事件流（与 MCP 服务同一套），不碰内核内部。样板是 `plugins/example-eval`（M7）：`src/link.ts` 是它和 Spica 之间唯一的连接（stdio 起一个新的 Spica，或 HTTP 连一个在跑的 Spica），`src/journeys.ts` 把 J2–J7 写成一串 `spica_*` 调用和检查（J6 与 `packages/plugins/scripts/journey-j6.ts` 同步骤，但在自己新建的会话里跑），`src/evaluate.ts` 逐个跑、按这段时间新增的可追溯记录算花费和请求数，`src/report.ts` 出 Markdown 报告（通过 / 失败 / 跳过、耗时、花费），`--log` 顺带导出被测 Spica 的使用日志。连在跑的 Spica 时，需要本次放样例文件或要重启的旅程（J2–J4、J7）标「跳过」。报告和日志都按 key、端点地址、MCP 令牌去敏。
- `npm run journeys -w @spica/core`（全仓验收 `npm run acceptance` 的 core 一步）现在就是调这个插件跑 J2–J5、J7；J6 仍由插件系统的 `journey:j6` 跑。

## 12a. 项目与三层团队（M4，已实现）

立项书的卖点在内核里变成一等概念：**项目 = 一个文件夹 + 一个常驻的项目经理会话**，顶层会话管所有项目。

**数据模型**（新增表，都在 sqlite 里）

| 表 | 字段 | 说明 |
|---|---|---|
| `projects` | id、name、folder（绝对路径）、manager_session_id、workflow_id、stage、status（active / archived）、created_at、updated_at | 一个项目一行 |
| `project_log` | id、project_id、session_id、at、kind（file_write / file_edit / command / stage / decision / note）、summary、path | 项目经理和它的子 Agent 在项目里的**关键操作**，给顶层留的系统级记录 |
| `work_objects` | id、project_id、level、name、parent_id、data_json、created_at | 工作对象实例（层级由流程文件声明，层数不固定） |

- 会话记录多一个 `projectId`（项目经理和它开出的子 Agent 都带），工作文件夹默认就是项目文件夹。
- 顶层会话全局只有一个：`runtime.top()` 没有就建、有就返回。项目经理的父会话是顶层，子 Agent 的父会话是项目经理（三层就是会话树）。

**流程与工作对象从文件读**：一个流程一个 JSON 文件（不引第三方 YAML 库），放在 `workflowsDir`（部署配置；示例在 `packages/core/examples/workflows/product-development.json`）。坏文件按文件名报出来（`runtime.workflowErrors`）并跳过，不影响其他文件：

```json
{
  "id": "product-development",
  "name": "新产品开发",
  "stages": [
    { "id": "sample", "name": "样品", "goal": "做出能验证功能的样品", "exitCriteria": ["样品测试报告", "客户确认"] },
    { "id": "pilot", "name": "试产", "goal": "小批量验证工艺" },
    { "id": "mass", "name": "量产" }
  ],
  "objectLevels": [
    { "id": "product", "name": "产品" },
    { "id": "part", "name": "部件", "parent": "product" }
  ]
}
```

换部门、换公司只换文件；内核只认结构，不认内容。

**工具**

| 谁用 | 工具 | 做什么 |
|---|---|---|
| 顶层 | `create_project {name, folder?, workflow?, brief?}` | 建项目：文件夹不存在就建（默认放在部署配置的项目根目录下）、建项目经理会话、把 brief 作为第一条任务发给它 |
| 顶层 | `list_projects` | 每个项目一行：名字、文件夹、阶段、项目经理状态、最近一条关键操作、花费 |
| 顶层 | `open_project {project}` | 看一个项目的近况：阶段、工作对象、最近关键操作、项目经理最近的回答、在跑的子 Agent |
| 顶层 | `message_agent {id, text}` | 已有；顶层可以对项目经理说话（项目经理是它的孩子） |
| 项目经理 | `project_status` | 本项目的流程、当前阶段的目标和出口条件、工作对象树 |
| 项目经理 | `set_stage {stage, note}` | 换阶段（只能是流程文件里的阶段），记一条 stage 关键操作，回传给顶层 |
| 项目经理 | `add_work_object {level, name, parent?}` / `list_work_objects` | 维护工作对象（层级按流程文件校验） |

**谁看得见哪些工具**：顶层工具只给 `role: top` 的会话（单独的顶层会话，以及界面里没有父会话的普通对话：任何顶层对话都可以建项目，项目经理的父会话始终是那个唯一的顶层会话）；项目工具只给带 `projectId` 的会话（项目经理和它的子 Agent）。

**每轮的项目提示**：内核自带钩子 `core:project`，给项目里的会话在系统提示后面加一行「你为哪个项目工作、文件夹、流程、当前阶段和目标」，阶段一变下一轮就是新的。

**子会话里用户的改动优先**（统筹定，J4 要验的点）：带队的会话（顶层、项目经理、任何有子会话的会话）系统提示里每轮都有一条规则：收到「用户在子会话里说了 / 定了什么」的备注时，它优先于原计划，要套用到总体结论，并在回答里说明是按用户在子会话里的改动调整的。

**关键操作记录**：项目内的会话 write_file / edit_file 成功、run_command 执行、set_stage、record_decision、开子 Agent、子 Agent 回报时自动记一条 `project_log`，发 `project.activity` 事件；顶层的 `list_projects` / `open_project` 读它。条目是结构化的：`action`（file.write / file.edit / file.delete / command / child.spawn / child.report / decision / stage / note）、`target`（相对项目文件夹的路径、命令、子 Agent 名或阶段 id）、`detail`；界面按这些拼中文，`summary` 是写给模型看的英文。旧字段 `kind` / `path` 暂留，外壳切过去后删。项目经理和子 Agent 的完整交互照旧进 `messages`。

**角色模板（给常驻成员留的口）**：`RoleTemplate {id, name, system, tools?, providerId?, model?}`，部署时注册；`createSession({ templateId })` 套用。内置两个：`top`（顶层）和 `project-manager`。常驻成员以后就是「带模板 + 记忆接口的长期会话」，首版不做记忆。

**接口与事件**：AgentApi 加 `createProject`、`listProjects`、`getProject`；事件加 `project.created`、`project.updated`（阶段等）、`project.activity`。

## 12b. 后端进程与 MCP 服务（M5，内核部分已实现）

**已实现**（`packages/core/src/host/`、`src/mcp/server.ts`）：
- `wire.ts`：线上消息 `req / res / event / ready`；`electronPort()`、`nodePort()` 两种端口适配。
- `server.ts`：`BackendServer` 把 AgentApi 和 `eventsSince`、`workflowErrors` 挂在端口上，事件按 seq 推送并留最近 5000 条。
- `client.ts`：`connectBackend(port)` 给主进程一个同接口的 AgentApi，外加 `call(方法, …)`、`onEvent`、`ready`、`fail()`（内核进程死了时让挂着的调用立刻失败）。
- `backend.ts`：`startBackend(config)`：provider 配置（key 随配置从端口传进来，`apiKeyEnv` 供独立模式用环境变量名）、`<库>.lock` 单写者锁、`restore()`、`extractorModules`（例如 `@spica/extract`）、端口上的 `probeProvider`。
- `utility-entry.ts`：Electron `utilityProcess.fork()` 的入口。主进程发 `{type:'start', config}` 并附一个 MessagePort；之后可以用 `{type:'connect'}` 再接一个端口（窗口重载后），用 `{type:'shutdown'}` 正常退出。内核回 `{type:'started', restored, warnings}` 或 `{type:'failed', code, message}`。
- `scripts/electron/host-check.ts`：在真 Electron 里 fork、跑一轮、杀掉、重启、确认历史还在、正常退出，五项都通过（`npm run check:electron-host -w @spica/core`）。
- `mcp-main.ts` + `mcp/server.ts`：stdio MCP 服务（`node src/host/mcp-main.ts --config backend.json`）。工具见下文；库被别的进程占着时直接拒绝并说明原因。
- **MCP 的 HTTP 传输（M7，`src/mcp/http.ts`）**：给远程 Agent 调试、另一台机器或容器里的评测用。stdio 和 HTTP 共用一个 `mcpDispatcher`，工具完全一样。
  - 用法：独立进程 `node src/host/mcp-main.ts --config backend.json --http [--port N] [--host H] [--allow-remote] [--token-file 路径]`；桌面端开着时，库被它占着，独立进程开不了，就在后台配置里加 `mcpHttp: { port?, host?, allowRemote?, tokenEnv?, tokenFile? }`，由正在跑的后台一起提供。端口方法 `mcpHttp()` 只回地址和令牌文件路径，不回令牌。
  - 协议：MCP「Streamable HTTP」的子集。`POST /mcp`，一条 JSON-RPC 或一批，回 JSON；通知回 202。不做服务端推送（GET 回 405），不发 `Mcp-Session-Id`（每个请求自成一体，事件靠 `spica_events` 按 seq 取）。`spica_run` 会等很久，所以不设请求超时。
  - **安全边界**：
    1. 默认只听 `127.0.0.1`；要听别的地址必须同时给 `allowRemote`，否则启动就报错。开了远程等于把「替你跑命令、读写文件、花模型钱」交给知道令牌的人，而且是明文 HTTP：只在可信网络里用，或者放在 SSH 隧道 / 反向代理（TLS）后面。
    2. 每个请求都要 `Authorization: Bearer <令牌>`，先验令牌再看别的（不读正文），比较用定长摘要 + `timingSafeEqual`。令牌至少 16 个字符；不给就生成 256 位随机令牌。来源：环境变量（独立进程是 `SPICA_MCP_TOKEN`，后台配置里是 `tokenEnv` 指定的名字），没有就生成；生成的写进 `--token-file` / `tokenFile`（权限 600），没给文件时在 stderr 只显示一次。令牌不进可追溯记录、事件、导出的使用日志；`SPICA_` 开头的环境变量本来就不传给子进程。
    3. 只听本机时，`Origin` 或 `Host` 不是本机的请求一律 403：防网页借 DNS 重绑定打到本机服务。
    4. 只收 `application/json`，单个请求最多 4 MB。
  - 测试（`src/mcp/http.test.ts`）：没令牌 / 错令牌 401 且什么都没跑；带令牌能 initialize、列工具、`spica_run` 跑通、批量请求；令牌不出现在记录、事件、导出里；别的站点的 Origin / Host 403，GET 405，非 JSON 415，超大 413；不给 `allowRemote` 不能听 0.0.0.0，短令牌拒绝；后台配置起 HTTP、写令牌文件、端口上查到地址但查不到令牌。另外手动起过一次 `mcp-main --http`：带令牌列出 24 个工具，不带令牌 401。
- **扩展模块**：`BackendConfig.extensions: {module, options}[]`，模块导出 `attachBackend(runtime, options)`，返回 `{ mcpTools?, methods?, warnings?, close? }`：工具加到 MCP 服务上，方法加到后端端口上，关闭时先于 runtime 调 `close()`。插件包就是这样把安装 / 启用 / 停用 / 列表挂上来的（内核不依赖插件包）。`spica_list_tools` 列当前工具和来源。
- **还没做**：主进程监护（重启退避、`shutdown`、把 `createAgentApi` 换成 `connectBackend`）在 apps/desktop，归桌面外壳，按上面的消息做即可；HTTP 传输（可选）。
- **运行中改设置，不重启后台**：端口上的 `configure(patch)`（`SettingsPatch`）一次可改：provider 全量列表（新的加、改的换、没列的删；限流器和排队的人保留）、新会话的默认 provider / 模型、限流并发和每分钟请求数、花费上限和价表、流程文件夹（重读并返回问题）、界面语言、搜索接口（`null` 去掉 web_search）、邮件设置（开关、间隔、批量、忽略规则、分拣规则和模板）。发 `runtime.configured { changed, warnings }`；邮件另发 `mail.configured { settings, running }`。正在跑的会话保留自己的 provider 和模型；它用的 provider 被删了，下一次调用会以「unknown provider」的错误结束，不会卡住。`mailSettings()` 返回当前邮件设置、是否在轮询、有哪些来源。
- **仍然只在启动时定的**：数据库路径（换库等于换一份数据，要重启后台）、扩展模块列表（插件的启用停用走插件系统自己的接口，不用重启）、run_command 的大输出存放目录（设置页没有这一项）。

（以下是原设计）



**进程边界**：内核跑在 Electron 的 `utilityProcess` 里（用 Electron 自带的 Node），主进程只做监护和转发，界面在渲染进程。SQLite 只有内核进程打开，主进程和界面都不碰库。

```
渲染进程（界面） ──IPC──► 主进程（监护、转发、窗口） ──MessagePort──► 内核进程（Runtime + SqliteStore + MCP 服务）
                                                                        └─ stdio / 本机 HTTP ──► 外部 MCP 客户端（评测、远程调试）
```

**消息通道**：主进程和内核进程之间用 `MessageChannelMain` 的一对端口，消息三种：

| 方向 | 形状 | 用途 |
|---|---|---|
| 主 → 内核 | `{ id, method, params }` | 调 AgentApi 的方法（和现在的 `createAgentApi` 同一套名字和参数） |
| 内核 → 主 | `{ id, result }` 或 `{ id, error: { code, message } }` | 回结果；错误是人话 + 代码 |
| 内核 → 主 | `{ event: CoreEvent }` | 事件流原样推送（带全局 `seq`） |

- 内核在内存里留最近几千条事件；界面断线重连时用 `eventsSince(seq)` 补齐，补不上（内核重启过）就重新拉 `listSessions` / `getMessages`，历史本身就能重建所有卡片。
- **给外壳的改法**：现在主进程里直接 `createAgentApi(runtime)`；M5 换成一个实现同一 `AgentApi` 接口的「端口客户端」，界面一侧不用改。

**监护与恢复**：
- 内核进程意外退出：主进程按 1 秒、2 秒、5 秒退避重启（1 分钟内最多 5 次，超过就给界面一个「后台出错」的人话提示和「重试」），新进程启动后先 `restore()`：在跑的会话变「中断」，提问卡和确认卡都还在，界面显示「上次没做完就中断了 [继续]」。
- 正常退出：主进程发 `shutdown`，内核 `close()`（在跑的会话标「中断」、停掉 MCP server、关库）后退出；5 秒没退就强杀。
- 窗口始终不死：内核崩了只影响后台，界面保留已显示的内容并提示「正在恢复」。

**本程序的 MCP 服务**（立项书「接口先行」：对外就是 MCP 服务，J2–J7 经它自动跑，评测插件走它）：
- 同一个内核进程对内服务界面、对外当 MCP 服务，两边看到的是同一份会话和同一个事件流。
- 传输：stdio 必有（`spica-core --mcp`，用 Electron 自带 Node 以 `ELECTRON_RUN_AS_NODE=1` 起，给评测和脚本用）；本机 HTTP 可选（只听 127.0.0.1，带随机令牌，令牌写在用户目录里），给远程调试和「程序开着时外部也想连」用。
- 工具：每个 AgentApi 方法一个工具（`spica_create_session`、`spica_send`、`spica_steer`、`spica_answer`、`spica_confirm`、`spica_get_messages`、`spica_create_project` ……），外加两个方便自动化的：`spica_run`（发一句话并等这次运行结束，返回回答、工具调用摘要和花费）和 `spica_events {since}`（拉事件）。
- 同时只能有一个进程写库：程序开着时 stdio 方式会发现锁（库旁的锁文件带进程号），改为连到正在运行的那个实例的本机 HTTP。
- **测试连接探针**：`probeProvider(配置)` 按给定 provider 配置发一次最小请求（一句 ping、max_tokens 很小），返回是否成功、延迟、服务端报的模型名、人话错误；不进任何会话，记一条 `initiator: 'runtime:probe'` 的可追溯记录。外壳设置页的「测试连接」直接调它。

## 12c. 邮件流水线（M6，已实现第一版）

立项书卖点第一条：来信自动归入对应项目，由该项目的项目经理给出建议并持续跟进。内核只认「邮件来源」这个抽象，不认识哪家邮箱。

```
邮件类插件的工具 ──(内核按间隔直接调用，不经模型)──► 新来信存进 mail_items
      ▼
分拣线程（顶层的专用线程，模板 mail-triage）：一批信 + 项目清单 + 发件人记忆 ──► triage_mail 工具（结构化结果）
      ▼
归到项目的 ──► 发给该项目经理（父会话发话，带邮件 id）──► 项目经理用 suggest_actions 给建议，回信只用插件的草稿工具，不发送
新事务 / 忽略 ──► 只记下来，界面上给用户看
      ▼
用户在界面上采纳 / 忽略 / 改归属 ──► 写回 mail_items 和「发件人 → 项目」记忆，下一批分拣用
```

**邮件来源**：`{ id, listTool, readTool, listArgs?, fields? }`。正常情况下由插件自己声明：插件清单里写 `mail: { list_tool, read_tool }`，插件包在启用时调 `runtime.mail.addSource()`，停用时撤掉，所以部署配置里**不出现任何插件工具名**；`mail.sources` 只给没有清单的特殊接法留着。
- `listTool` / `readTool` 是插件工具的完整名字（由插件包按清单拼出来）；`listArgs` 默认 `{ unread_only: true, limit: 50 }`；`fields` 把结果里的字段名映射成内核的（默认 `id`、`from_name`、`from_address`、`subject`、`received`、`preview`）。
- 工具不在（插件没装 / 停用）时这个来源跳过，不报错；插件的模拟模式照样能跑通整条链。
- 结果文本里 JSON 前面的 `[…]` 提示行（模拟模式、取数时间）先去掉再解析。
- 读信不标已读（插件已定）；内核按邮件 id 去重，同一封只分拣一次。

**后台任务**：`mail: { enabled, intervalMinutes (默认 5), batchSize (默认 20), triageTemplateId?, rules? }`。启动后先跑一次，之后按间隔跑；上一轮没结束就跳过这一轮；`pollMail()` 可以手动触发。没有任何邮件来源时不启动。

**分拣**：
- 分拣线程是一个顶层线程（模板 `mail-triage`，可被部署覆盖），工具只有 `triage_mail`、`list_projects`、`open_project` 和来源的读信工具。
- 每批发一条消息：项目清单（id、名字、阶段）、这批信（mail id、发件人、主题、时间、预览）、发件人记忆（「这个发件人以前被你归到项目 X」）、部署或插件注入的分拣规则（`mail.rules` 文本，或插件用 `inject` 钩子加）。
- 模型必须调 `triage_mail { results: [{ mail_id, decision: 'project' | 'new' | 'ignore', project_id?, suggestion?, reason, confidence }] }`。内核校验：项目必须在清单里，这一批每封信都要有结果；不合格的和漏掉的在工具结果里点名，模型同一轮改正。合格的写进 `mail_items`，发 `mail.triaged` 事件；这一轮还没结果的信留到下一轮。
- **不问模型就定的三种情况**（按顺序）：① 配置的忽略规则 `mail.ignore: { from?, subject? }`（每条是不分大小写的子串，或写成 `/正则/标志`），命中就忽略，`by: 'rule'`；② 用户归过项目的发件人（采纳或改归属），直接归到同一个项目，`by: 'sender_memory'`；③ 用户忽略过的发件人，直接忽略，`by: 'sender_memory'`。用户之后的处理会覆盖之前的记忆。
- **分拣角色可配**：模板 `mail-triage` 可被部署的同名模板替换，或用 `mail.triageTemplateId` 指定别的模板；分拣线程的工具表随当前启用的邮件来源自动更新。

**转给项目经理**：每轮每个项目经理只收一条消息，列出这一轮归给它的所有信（`meta.mails` 是邮件 id 和来源的数组），内容是发件人、主题、时间、预览，以及要求：先用读信工具看全文，用 `suggest_actions` 给用户几个下一步；起草回复只用插件的草稿工具，不发送；移动、标记照插件已定的确认规则。发 `mail.routed` 事件。

**用户处理**：`mailFeedback(mailId, { action: 'accept' | 'ignore' | 'reassign', projectId? })`。改归属时转给新的项目经理；采纳和改归属更新发件人记忆；全部写进 `mail_items.feedback`，发 `mail.feedback` 事件。

**数据**：`mail_items`（id = 来源:邮件 id、来源、邮件 id、发件人名和地址、主题、时间、预览、状态 new / triaged / routed / ignored、分拣结果 JSON、用户处理 JSON、时间戳）；`mail_senders`（发件人地址、决定 project / ignore、项目 id、更新时间）。

**接口与事件**：AgentApi 加 `listMail(filter)`、`pollMail()`、`mailFeedback()`（先可选）；事件 `mail.polled`、`mail.triaged`、`mail.routed`、`mail.feedback`，都带结构化字段，界面自己写中文。

**不做的**：内核不发邮件、不认任何公司的邮箱或规则；归类规则只能由配置或插件注入。

## 13. 未决问题

- 「收到响应后改响应」与逐字流出的矛盾：默认先流给界面、响应完整后再交钩子；钩子若改了内容，发一个 `message.replaced` 事件让界面替换。是否需要「缓冲模式」由插件声明。
- 价表默认值未核实，需对照各家公开价格。
- web_search 非 Anthropic 时接哪家搜索接口，待定（接口可插，通用 JSON 适配器已有）。
- **Node 24.15 在 Windows 上中止 HTTP 流时偶发硬崩溃**（退出码 0xC0000409，无 JS 栈、无崩溃报告）。纯 `fetch` 和 `node:http` 都能复现，不经过 Spica 代码；进程里没有第三方 DLL。压力测试大约每几千次中止崩一次；全量测试在安静的机器上约 10 次里有 1 次某个测试进程这样退出（从没有断言失败）。产品影响：一次插话或报错 = 一次中止，平时概率很低，但内核跑在 Electron 主进程里时会把整个桌面端带走。复现脚本和用法在 `packages/core/scripts/diag/`。
  - 已做（统筹定）：**中止改成软的**。用户插话 / 停止不再 abort 连接：拿到响应头之前就不等了、等它回来再丢掉正文；之后由读流的一方 `cancel()`。只有「等响应头超时」还会硬中止。
  - 实测（每次 300 轮「开流→停→再发一次」，每轮之间留出端口冷却）：

| 运行时 | 硬中止（纯 fetch / node:http） | Spica 软停止 |
|---|---|---|
| 系统 Node 24.15.0 | 旧版内核 2/6 次崩；纯 fetch、node:http 各偶发 1 次 | 0/8 崩 |
| Electron 45 自带 Node 24.22.2 | 16 次都没有 0xC0000409（几次退出码 1 是压测把本机端口用光，不是这个问题） | 冷却后通过 |

  - 结论：桌面端实际跑的 Electron 自带 Node 上没复现；内核也已改成软停止。内核放进 Electron utilityProcess（崩了拉起、`restore()` 接着干）在 M5 里做，作为兜底。
- 冒烟里观察到：项目经理收到「用户在子会话里改方向」的回传后，有时会判断这只是对那个子任务的要求，不套用到总体结论，并会问用户。回传本身没丢；要不要在系统提示里规定「子会话里用户的改动优先」，看他的意思。

## 14. 验收记录

| 里程碑 | 日期 | 测试 | 真模型冒烟 |
|---|---|---|---|
| M7 | 2026-11-10 | 新增：16 个子任务同时跑的压力测试（限流排队按顺序、位次 n→1、花费上限按预留算不超、排队中 / 运行中被停释放）、停用工具的拒绝与备注、使用日志导出（两个项目、去敏、项目和时间筛选、只读命令行）、MCP 的 HTTP 传输（令牌、本机、Origin、大小）、评测插件（经 HTTP 跑 J5、跳过与失败、插件清单合法）；core + plugins + 评测插件 211 条 | `npm run eval -w @spica/plugin-example-eval`：只经 MCP 服务、DeepSeek flash，J2–J7 六项全过，55 秒，32 次请求约 0.0134 USD；同库导出的使用日志 143 行，报告和日志里没有 key 和端点地址。J6 修复后 `journey:j6` 连跑两次 7/7 |
| M6 | 2026-11-09 | 邮件流水线 6 条（分拣 → 转给项目经理 → 不重复；拒绝不存在的项目并让模型改正；漏掉的信被点名后补上；采纳 / 改归属教会发件人记忆，同发件人下次不问模型直接转；没有邮件插件时什么都不跑） | `npm run smoke:mail -w @spica/core`：只经 MCP 服务，Outlook 插件模拟模式（收件箱 23 封，模拟邮箱共 30 封）+ DeepSeek：23 封全部分拣（网站改版 4、办公室搬迁 4、新事务 7、忽略 8），两个项目经理各只收到自己的信并用 suggest_actions 给建议，没有发送任何邮件；约 0.022 USD |
| M5 | 2026-11-09 | 20 个测试文件全过（新增：端口协议与回放、后端启动 / 锁 / 重启恢复 / 端口上的测试连接、stdio MCP 服务：工具、运行、事件、重启后状态还在、第二个写者被拒、测试连接探针）；真 Electron 检查五项通过 | `npm run journeys -w @spica/core`：只经 MCP 服务、用 DeepSeek 跑 J2（PDF / Word / Excel 三问全对，三张文件卡）、J3（建项目、两个子 Agent）、J4（用户在子会话改方向，项目经理按改动给结论）、J5（提问卡 → 确认 → 执行）、J7（运行中关掉后端、重开、续跑完成），全部通过，约 0.011 USD |
| M4 | 2026-11-09 | 16 个测试文件 130 条全过（新增：流程文件校验、角色模板、建项目与三层父子关系、阶段校验与回传、工作对象层级、关键操作记录、项目跨重启、工具按角色可见、项目提示、带队规则、AgentApi 项目命令） | DeepSeek flash 项目冒烟（`npm run smoke:project -w @spica/core`）：顶层建项目 → 项目经理并行开两个子 Agent → 用户在 B 里说「只看付款和认证、不看价格」→ 项目经理按这两项给结论，并写明「在 supplier-b 会话里用户说……所以我调整了建议」；它的决定也回传到顶层；13 次调用约 0.0065 USD |
| M3 | 2026-11-09 | 15 个测试文件 112 条全过（新增：sqlite 存储、正常关闭 / 提问卡 / 会话树跨重启、两种强杀、wso2 token 流程、run_command、web_fetch / web_search、MCP 客户端、文件卡、提取器请求） | DeepSeek flash：读文件→grep→答对，2 次调用约 0.0005 USD；团队冒烟仍通过（9 次调用约 0.004 USD） |
| M2 | 2026-11-09 | 10 个测试文件 72 条全过（新增：钩子六位置与撤销、两种插话、确认与提问卡、会话树与回传、限流与花费上限、AgentApi 适配） | DeepSeek flash 团队冒烟（`npm run smoke:team -w @spica/core`）：项目经理并行开两个子 Agent 各读一份报价，用户中途进 B 改方向「只看付款和认证」，回传到项目经理，项目经理的结论明确按这次改动写；9 次调用约 0.004 USD |
| M1 | 2026-11-09 | 5 个测试文件 40 条全过（流式解析、两种 provider 往返、重试 / 不重试 / 中止、文件工具、读文件→grep→回答整条循环、父链） | DeepSeek flash：read_file + grep 并行 → 正确回答，2 次调用约 0.0006 USD；Haiku 5.5：同样通过，2 次调用约 0.0004 USD，第二次命中缓存 1491 token |

## 15. 交接（2026-11-09 更新）

**状态**：M1–M7 完成并回报（M7：并行花费上限、停用工具、使用日志导出、MCP 的 HTTP 传输、评测插件 plugins/example-eval）。工作区里 packages/core、packages/protocol、本文档没有未提交的改动。提交前用一个小脚本把关：根目录 lint、typecheck 和内核测试都绿才提交（内核测试遇到 Node 的 0xC0000409 崩溃会自动重跑一次）。

**下一步**：
1. 桌面外壳：主进程用 `utilityProcess.fork(packages/core/src/host/utility-entry.ts)` 起内核，按 12b 节的消息接 `connectBackend`，崩了退避重启（1/2/5 秒，1 分钟最多 5 次）；设置页「测试连接」调 `call('probeProvider', 配置, 模型)`。
2. J6 已由插件系统经 MCP 跑通（751a20b，`journey:j6` 在插件包里）。
3. 内核：AgentApi 的项目命令在 protocol 里改成必选（外壳实现后）。HTTP 传输已在 M7 做完（12b 节）。

**注意**：
- 只 add 自己的路径（packages/core、packages/protocol、本文档）；改 package.json 要和锁文件同一个提交。
- 远端 `origin` = https://github.com/KanbaraKenji/SPiCa.git（公开仓，分支 main）。各会话只做本地提交，不 git push；每到一个绿的节点给统筹发一句「可推」，由统筹统一推送（推前扫历史）。仓库是公开的：提交前确认没有 key 和模型端点地址进文件。
- 用 Python 改文件时 `\n` 这类转义容易被写成真换行，改完先 typecheck；在 Windows 上用 Edit 工具最稳。
- 全量测试偶发被 Node 的 0xC0000409 打断（见 13 节），断言本身不失败。
