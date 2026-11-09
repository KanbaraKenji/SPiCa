# Outlook 邮件插件设计（`plugins/outlook-mail`）

> 状态：首版完成（2026-11-09）。8 个工具、16 个错误码、模拟模式 30 封、分拣技能、项目文件夹钩子都做通；测试 59 条、冒烟 17 项全过。真 Outlook 只验到「装了经典版、没配置邮箱」这一步（这台机器两种 Outlook 都装了，但经典版没登录过邮箱），读信 / 起草的 COM 代码对着一套假 Outlook 对象验过，**还没在登录了的真 Outlook 上跑过**；统筹定真机验证留到公司电脑（步骤见第 9 节）。
> 需求来源：立项书「邮件」「插件」「硬规则」「硬环境约束」；插件格式见 `plugins.md`、`docs/plugins/authoring.md`。

## 1. 工具表

清单 `name` 定为 **`outlook`**（工具前缀，定了不改；目录名 `outlook-mail` 与示例 `example-notes` / `notes` 同理）。模型看到的工具名是 `outlook__<工具>`。

| 工具 | 参数 | 返回 | 副作用 / 确认 |
|---|---|---|---|
| `status` | 无 | 模式（模拟 / 真机）、Outlook 状态（装了没、有没有配置文件、开着没）、邮箱账户显示名 | 只读 |
| `list_folders` | `mailbox?`（邮箱显示名，默认主邮箱） | 文件夹树：路径、未读数、总数 | 只读 |
| `list_messages` | `folder?`（默认 `inbox`）、`unread_only?`、`from?`、`query?`（主题 / 发件人 / 正文包含）、`since?`、`until?`（ISO 日期）、`has_attachments?`、`limit?`（默认 20，最多 50）、`offset?` | 每封：`id`、发件人名和地址、主题、收到时间、未读、有无附件、重要性、分类、预览（≤120 字）；`total`、`next_offset` | 只读 |
| `read_message` | `id`、`format?`（`text` 默认 / `html`）、`max_chars?`（默认 8000） | 发件人、收件人、抄送、主题、时间、分类、会话主题、正文（超长截断并标明）、附件清单（序号、文件名、大小） | 只读（读正文不会把邮件标成已读） |
| `mark_read` | `ids`、`unread?`（true 表示标回未读） | 改了几封 | 可逆（能标回未读），不确认 |
| `move_messages` | `ids`、`folder` | 每封移动后的新 `id` | 进 `permissions.irreversible`，调用前确认 |
| `save_attachments` | `id`、`dest_folder?`（默认「项目文件夹/attachments」，相对路径按项目文件夹算）、`names?`（不填存全部）、`overwrite?` | 写下的完整路径；默认重名自动加 ` (1)` 不覆盖 | 不覆盖时不确认；`overwrite: true` 时由插件钩子要求确认；只能写项目文件夹或插件数据目录 |
| `create_draft` | `reply_to?`（邮件 id）、`reply_all?`、`to?`、`cc?`、`subject?`、`body`、`open_window?` | 草稿 `id`、放在「草稿」文件夹、有没有打开草稿窗口 | 只存草稿、可删，不确认；**不发送** |

确认规则是统筹 2026-11-09 按立项书「不可逆动作才默认确认」定的：只有 `move_messages` 进不可逆清单；`save_attachments` 只在要覆盖已有文件时确认。

- 取数时间：内核给每条工具结果第一行加 `[fetched at …]`（`session.ts`），插件不重复加；结果不缓存，每次现取。
- 模拟模式下结果第一行再加 `[sample data — mock mode]`。

## 2. 错误码

工具出错时返回 `isError: true`，正文第一行形如 `[OUTLOOK_NOT_RUNNING] Outlook 没打开。请先打开 Outlook，再让我试一次。`

| 错误码 | 什么时候 | 给人看的话（大意） |
|---|---|---|
| `NOT_WINDOWS` | 不是 Windows 且没开模拟模式 | 只能在 Windows 上读 Outlook；可以打开模拟模式用样例邮件 |
| `OUTLOOK_NOT_INSTALLED` | 经典版和新版都没有（只剩 COM 注册表残留也算没有） | 这台电脑上没有装 Outlook，本插件需要经典版 |
| `OUTLOOK_NEW_ONLY` | 只有新版 Outlook（olk.exe） | 新版 Outlook 不支持本地自动化，需要经典版（开始菜单里叫「Outlook (classic)」） |
| `OUTLOOK_NO_PROFILE` | 经典版装了，但没有配置文件 | 经典版 Outlook 已经装了，但还没有配置邮箱账号，先打开「Outlook (classic)」登录一次 |
| `OUTLOOK_NOT_RUNNING` | Outlook 没开（插件不替你启动，免得弹向导） | Outlook 没打开，先打开再试 |
| `OUTLOOK_BUSY` | Outlook 有对话框开着、正在忙（RPC 拒绝调用） | Outlook 正忙或有窗口等你处理，关掉后再试 |
| `OUTLOOK_SECURITY_BLOCKED` | 对象模型保护的安全提示被拒或超时 | Outlook 弹了安全提示并拒绝了访问；需要允许，或请管理员处理杀毒软件状态 |
| `POWERSHELL_RESTRICTED` | 受限语言模式（AppLocker / WDAC）禁止 COM | 这台电脑的策略不允许脚本访问 Outlook，请联系管理员 |
| `POWERSHELL_FAILED` | powershell.exe 起不来或输出看不懂 | 后台组件出错，详情在插件日志 |
| `TIMEOUT` | 一次调用超过时限 | Outlook 太久没回应 |
| `FOLDER_NOT_FOUND` | 文件夹路径不存在 | 找不到文件夹「…」，可先用 list_folders 看 |
| `MESSAGE_NOT_FOUND` | id 失效（被移动、删除） | 找不到这封邮件，可能已被移动或删除，重新列一次 |
| `ATTACHMENT_NOT_FOUND` | 附件名不在这封邮件里 | 这封邮件没有叫「…」的附件 |
| `PATH_NOT_ALLOWED` | 保存位置不在项目文件夹 / 插件数据目录内 | 只能存到项目文件夹里 |
| `INVALID_ARGUMENT` | 参数缺失或不合格 | 具体哪个参数怎么改 |
| `COM_ERROR` | 其他 COM 错误（附 HRESULT） | Outlook 报错（代码 0x…），详情在插件日志 |

## 3. 目录

```
plugins/outlook-mail/
  manifest.json              name outlook；permissions.irreversible = [move_messages]；hooks = [beforeTool]；workspace = write
  mcp/outlook.json           Node 类 MCP server，单次调用超时 60 秒
  server/index.js            MCP stdio 循环（无依赖，照示例插件）
  server/tools.js            工具声明、参数检查、结果格式、日志摘要
  server/errors.js           错误码、中文提示、HRESULT → 错误码表
  server/outlook-backend.js  起 PowerShell、送请求、收答案
  server/outlook.ps1         真正调 Outlook COM 的脚本
  server/mock-backend.js     模拟模式：内存里的样例邮箱
  server/files.js            附件文件名清洗、重名加 (1)
  hooks/guard.js             save_attachments 只能写项目文件夹
  skills/triage/SKILL.md     分拣技能
  commands/triage.md         /outlook:triage
  mock/mailbox.json          30 封虚构邮件
  scripts/smoke.mjs          整流程冒烟
  test/                      4 个测试文件 + 假 Outlook（fake-outlook.ps1）
```

## 4. 怎么调 Outlook

**进程**：每次工具调用起一个 Windows PowerShell 5.1（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，Win10/11 都自带，不装东西、不要管理员），`-NoProfile -NonInteractive -NoLogo`，`spawn` 带 `windowsHide: true`、不经 shell，不弹窗。请求是一行 JSON 从 stdin 进，答案是一个 JSON 从 stdout 出，两头都设成 UTF-8（中文往返实测不乱码）。

**为什么用「小引导 + 读文件进 scriptblock」而不是 `-File outlook.ps1`**：脚本文件受执行策略管，公司若设了 AllSigned 会被拦；从文字建的 scriptblock 不受执行策略管。引导只有一行，用 `-EncodedCommand` 传，不用操心引号；脚本本身不走命令行，没有 3.2 万字符的长度限制。

**耗时**：这台机器上 PowerShell 冷启动加一次调用约 1.8–2 秒（实测，`status` 1.9 秒、`list_messages` 报错路径 2.0 秒）。分拣一轮通常是 1 次列表 + 少量读正文，可以接受；要更快就改成常驻一个 PowerShell 进程（见「以后」）。

**每次调用的顺序**（`status` 走同样的检查，把结果作为 `state` + 一句中文 `hint` 返回，不报错）：
1. 语言模式不是 FullLanguage（AppLocker / WDAC 受限模式）→ `POWERSHELL_RESTRICTED`
2. **经典版装没装看程序文件，不看注册**：从 64 位和 32 位两份注册表里读 `Outlook.Application` 的 CLSID → `LocalServer32` 指向的 exe，至少有一份**文件真的存在**才算装了（只看注册会把卸载残留误判成已装）。都没有时再看新版：`%LOCALAPPDATA%\Microsoft\WindowsApps\olk.exe`（新版的启动别名），没有再查 `Get-AppxPackage Microsoft.OutlookForWindows` → 有新版报 `OUTLOOK_NEW_ONLY`，没有报 `OUTLOOK_NOT_INSTALLED`
3. **32 位 Office 的 64 位注册坏了**：64 位 PowerShell 读的是 64 位那份注册；若只有 32 位那份指向真文件，脚本回一个内部信号，Node 这边改用 `SysWOW64` 里的 32 位 PowerShell 重跑这一次，之后这个 server 一直用 32 位（这台机器就是这样：Office 2019 32 位，64 位注册指向不存在的 `C:\Program Files\Microsoft Office\Root\Office16\OUTLOOK.EXE`）
4. 注册表 `HKCU\Software\Microsoft\Office\16.0|15.0\Outlook\Profiles` 下没有配置文件 → `OUTLOOK_NO_PROFILE`
5. 没有 OUTLOOK.EXE 进程 → `OUTLOOK_NOT_RUNNING`。**插件不替用户启动 Outlook**：没配置文件时 COM 拉起 Outlook 会弹配置向导，违反「不弹窗」；Outlook 本来就是用户常开的。
6. `New-Object -ComObject Outlook.Application`（Outlook 是单实例，开着时这是连上去，不是再开一个）→ `GetNamespace('MAPI')`；遇到 Outlook 忙（RPC 拒绝调用）重试 3 次、每次隔 0.5 秒。

**各工具怎么取数**：

| 工具 | 做法 |
|---|---|
| 文件夹定位 | `inbox / drafts / sent / deleted / junk / outbox` 走 `Store.GetDefaultFolder`（中文 Outlook 里收件箱叫「收件箱」也能找到）；其余从邮箱根目录按名字一级级找，不分大小写。路径用 `/`，和 `list_folders` 给的一样 |
| `list_folders` | 从根目录往下走 5 层、最多 500 个，只要邮件类文件夹（DefaultItemType = 0），未读数用 `UnReadItemCount` |
| `list_messages` | `Folder.GetTable(DASL 过滤)` + 只点名需要的列（EntryID、主题、发件人、时间、未读、重要性、分类、类型、SMTP 地址、有无附件、正文前 255 字做预览），按收到时间倒序；比逐封打开 Items 快一个量级。没有日期条件时总数用 `GetRowCount()`，翻到够一页就停 |
| 日期筛选 | **不写进过滤串**，在循环里比：过滤串里的日期字面量按 Windows 区域格式解析（这台是 zh-CN，`'g'` 格式是 `2026/11/9 8:05`），写 ISO 会错；倒序遍历遇到早于 since 的就停 |
| 文字筛选 | DASL `LIKE '%…%'` 查主题、发件人名、正文；单引号转义成两个。不用 `ci_phrasematch`（依赖 Windows 搜索索引） |
| `read_message` | `GetItemFromID`（先默认邮箱，再挨个邮箱试，兼容共享邮箱）；正文默认 `Body`，要 html 才取 `HTMLBody`；读正文不改未读状态；附件只列序号、文件名、大小、是否内嵌图（PR_ATTACHMENT_HIDDEN） |
| 发件人地址 | Exchange 内部发件人的 `SenderEmailAddress` 是 `/O=…` 那种长串，改取 `GetExchangeUser().PrimarySmtpAddress`，再不行取 PR_SENT_REPRESENTING_SMTP_ADDRESS |
| `mark_read` | 改 `UnRead` 后 `Save()`；只改状态不同的那几封 |
| `move_messages` | `item.Move(folder)`，返回移动后的新 EntryID（PST 和跨邮箱移动后 id 会变） |
| `save_attachments` | `Attachment.SaveAsFile`；文件名清洗（去掉 `<>:"/\|?*` 和控制字符、CON/NUL 这类保留名前面加 `_`、最长 150 字），默认重名加 ` (1)`，`overwrite: true` 才覆盖 |
| `create_draft` | 回复用 `Reply()` / `ReplyAll()`，新邮件用 `CreateItem(0)`；HTML 邮件把正文插在 `<body>` 后面，保住下面引用原文的格式（直接赋 `Body` 会丢格式）；`Save()` 进草稿箱；`open_window` 时 `Display($false)` 打开不阻塞。**脚本里没有任何 Send 调用，有测试守着** |

## 5. 已知坑

| 坑 | 现在怎么处理 | 真机核实 |
|---|---|---|
| 新版 Outlook（olk.exe）没有 COM | 只有新版时报 `OUTLOOK_NEW_ONLY`，提示要经典版 | 这台机器上检测到新版（启动别名在） |
| 卸载后 COM 注册还在 | 以注册指向的 exe 文件是否存在为准 | 测试覆盖 |
| 32 位 Office 的 64 位 COM 注册指向不存在的路径 | 自动改用 32 位 PowerShell | 这台机器上实际遇到并验过：`status` 走 32 位后正确报「经典版已装、没配置邮箱」 |
| 对象模型保护（杀毒软件过期时读地址 / 正文会弹「有程序在访问邮件」） | `0x80004004` / `0x80070005` 映射成 `OUTLOOK_SECURITY_BLOCKED`；这类错误在所有 try 里都不吞，一律报出来 | 待核实 HRESULT |
| Outlook 有对话框开着时 COM 调用被拒 | 连接时重试 3 次，之后报 `OUTLOOK_BUSY` | 待核实 |
| Outlook 以管理员身份运行、插件不是 | `0x80080005` 报 `OUTLOOK_NOT_RUNNING`，附一句「正常方式重新打开」 | 待核实 |
| 过滤串里日期按区域格式 | 日期不进过滤串（见上） | 已在 zh-CN 上看到 `g` 格式 |
| 草稿没有收到时间（4501-01-01） | 时间给 null，不参与日期筛选 | 假 Outlook 验过逻辑 |
| `CreateItem` 新邮件不带签名（签名只在打开窗口时加） | 不处理；`open_window: true` 时 Outlook 自己加 | 待核实 |
| PowerShell 5.1 把没有 BOM 的脚本当 ANSI 读 | outlook.ps1 只用 ASCII（有测试），引导用 UTF-8 读文件 | 已验 |
| PowerShell 把一个元素的数组拆成单个值 | 返回列表的函数前面加逗号保成数组 | 假 Outlook 验过 |
| 首次运行 PowerShell 往 stderr 写进度 XML | 引导里关掉进度输出；stderr 从不转发 | 已验 |

## 6. 模拟模式

- `SPICA_MOCK=1` 时用 `mock/mailbox.json`：虚构的小工作室「Maple Lane Studio」的 30 封信，中英文各一半左右；收件箱 23 封（15 封未读）、收件箱/Website Refresh 2、草稿 1、已发送 2、垃圾邮件 1（一封钓鱼样例）、归档 1。内容：采购订单与缺货、报价与改版报价、搬家报价、会议邀请 2 封、密码到期、备份报告、退信、客户咨询、续费提醒、设计意见、周报订阅、年假通知、报销待审批、会议室预订、维护通知等。三个虚构项目给分拣用：Website Refresh（官网改版）、Spring Open House（春季开放日）、Office Move（办公室搬迁）。
- 所有地址都是 `.example` / `.test` 域名（有测试），不含真实公司或行业内容；敏感词扫描 0 命中。
- 日期在加载时按整天平移，最新一封落在今天，时刻不变。
- 8 个工具在模拟模式下行为一致：标已读、移动、草稿改的是内存里的邮箱，插件重启（切模拟开关会重启）就复原；附件真的写进项目文件夹。结果第一行是 `[sample data — mock mode]`。

## 7. 安全边界

| 边界 | 做法 |
|---|---|
| 不发送 | 没有发送工具；脚本里没有 Send 调用（测试守着）；草稿只 `Save()`。发送由用户在 Outlook 里自己点 |
| 确认 | 只有 `move_messages` 在不可逆清单里（插件系统的 beforeTool 要用户确认）；`save_attachments` 要覆盖时由插件钩子要确认；标已读、建草稿不确认（统筹按立项书定） |
| 写文件 | 只有 `save_attachments` 写盘。插件钩子 `hooks/guard.js` 在调用到达 server 之前把 `dest_folder` 按会话的工作文件夹（项目经理就是项目文件夹）算成完整路径，不在项目文件夹或插件数据目录里的一律拒绝（`PATH_NOT_ALLOWED`）；server 自己也只收完整路径 |
| 日志 | 只记工具名、成功或错误码、HRESULT、耗时、数量和文件夹名；不记主题、发件人、正文、附件名（有测试：日志里搜不到样例邮件的关键词）。PowerShell 的 stderr 从不转发；未知错误只回异常的类型名，不回异常文字（COM 的报错文字可能带邮件主题） |
| 缓存 | 不缓存，每次现取；取数时间由内核加在结果第一行 |
| 环境 | 不装 Python、不装全局东西、不要管理员；用宿主自带 Node 跑 server，用系统自带 PowerShell 5.1 调 COM |

## 8. 测试与验收记录

| 日期 | 测试 | 冒烟 |
|---|---|---|
| 2026-11-09 | `npx vitest run plugins/outlook-mail`：4 个文件 59 条全过（含 2026-11-09 收尾加的 10 条：环境检查 7 种情况——没装、只有新版、残留 + 新版、只有残留、没配置文件、32 位 Office 注册坏、没开——和自动切 32 位 PowerShell）。`mock.test`（模拟模式每个工具：30 封、倒序、翻页、各种筛选、正文 / html / 截断、读不改未读、标已读与标回、移动、存附件与重名、草稿回复 / 全部回复 / 新邮件、7 种参数错误、日志不含邮件内容）；`errors.test`（10 个 HRESULT 映射、worker 自报错误码、受限模式、PowerShell 起不来 / 输出乱 / 超时、非 Windows）；`worker.test`（outlook.ps1 零语法错误、纯 ASCII、无 Send；对着假 Outlook 跑 21 个请求：文件夹树、列表翻页与 Exchange 地址、DASL 过滤串与单引号转义、日期筛选、收件人与附件、标记、移动新 id、存附件重名、HTML 草稿插入位置、只在要求时打开窗口、安全提示 / 忙 / 找不到 / 未知操作；本机真跑 status 且不会拉起 Outlook）；`plugin.test`（插件检查零问题、装上启用出 9 个工具、移动要确认而标已读和草稿不要、附件只进项目文件夹、覆盖要确认、停用全撤；样例邮件 30 封且只用示例域名） | `npm run smoke -w @spica/plugin-outlook-mail`：装上 → 模拟模式 30 封 → 读未读 → 移动要确认 / 标已读不要 → 附件进项目文件夹、外面被拦 → 起草回复进草稿箱 → 真 Outlook 检查（这台：经典版和新版都装了、经典版没配置邮箱，走 32 位 PowerShell，状态 `no_profile`，报 `OUTLOOK_NO_PROFILE`）→ 停用工具和钩子消失，17 项全过。eslint 过、敏感词扫描 0 命中 |

**真机没验到的**：读真列表、读真正文、建真草稿。这台机器经典版（Office 2019 32 位）和新版 Outlook 都装了，但经典版从没登录过邮箱；他不登个人邮箱，统筹定留到公司电脑验（见第 9 节）。

## 9. 以后

### 在公司电脑上验真机（下一步，经典版 Outlook + 工作邮箱）

1. 打开「Outlook (classic)」，确认工作邮箱能正常收信，Outlook 保持开着。
2. 在 Spica 仓库根目录跑：`npm run smoke -w @spica/plugin-outlook-mail -- --real-draft`
3. 第 1–5、7 步和在家一样（模拟模式），看第 6 步「真 Outlook」，预期：

   ```
   6. 真 Outlook
        经典版 是 · 新版 是/否 · 有配置文件 是 · 开着 是 · 64 位（或 32 位）PowerShell · 邮箱 1 个以上
     ✓ 状态：ready — Outlook 可以用了。
     ✓ 读真收件箱列表 — 约 2000 ms
     ✓ 读一封真邮件正文 — 约 2000 ms
     ✓ 真草稿已存进草稿箱（未发送） — 约 2000 ms
   ```

4. 去 Outlook 的「草稿」文件夹看：有一封回复收件箱最新那封信的草稿，正文第一行是 `Spica smoke test draft — safe to delete.`，下面是原信的引用、格式没乱；它**没有**出现在「已发送」里。看完删掉这封草稿。
5. 不加 `--real-draft` 跑就只读不写。

可能看到的其他结果和含义：

| 第 6 步看到 | 意思 | 怎么办 |
|---|---|---|
| `状态：not_running` + `[OUTLOOK_NOT_RUNNING]` | Outlook 没开 | 打开再跑 |
| `[OUTLOOK_SECURITY_BLOCKED]` 或 Outlook 弹出「有程序在访问电子邮件地址信息」 | 对象模型保护（多半是杀毒软件状态没被 Outlook 认到） | 点「允许」再跑；一直弹就记下来，问 IT；顺便核实这个提示对应的 HRESULT 是不是 0x80004004 |
| `[OUTLOOK_BUSY]` | Outlook 有提示框或登录框开着 | 关掉再跑 |
| `[POWERSHELL_RESTRICTED]` | 公司策略把 PowerShell 锁在受限模式 | 本插件在这台电脑上用不了，记下来另想办法（例如改成自带的小 exe） |
| `[TIMEOUT]` | 45 秒没回应，多半是弹窗在等人点 | 看 Outlook 有没有弹窗 |
| `[COM_ERROR] …（错误代码 0x…）` | 没见过的错误 | 把错误代码记下来，补进 `server/errors.js` 的 HRESULT 表 |

验完把结果写进第 8 节的验收记录，并把第 5 节「待核实」的几条改成实测结论。

### 以后再做

- 发送邮件（要确认、要能撤回期内取消）、日历、联系人、规则：首版不做。
- 常驻一个 PowerShell 进程，把每次约 2 秒降到零点几秒（要处理超时重启、Outlook 关掉后重连）。
- 多页列表的游标（现在用 offset，期间来了新信会错一位）。
- 新信到达时主动通知（Outlook 的 NewMailEx 事件要常驻进程）：做成插件的常驻进程（`services/`），给顶层发「来信了」。
- 插件设置表单（插件系统以后做）：默认分拣哪个文件夹、哪些发件人直接算通知。
- 附件读取：存进项目文件夹后由内核的 read_file + 文件读取提取器读，不在本插件里再做一遍。

## 10. 交接（2026-11-09）

- **做了什么**：上面全部；提交见 git log（`plugins/outlook-mail`、本文、package-lock.json 里新工作区的一条）。
- **收尾补的**（统筹转他的话：「我这台电脑好像没有经典版的outlook」）：`status` 分清「没装 / 只有新版 / 经典版装了没配置邮箱」并带中文提示；经典版以程序文件为准，不被注册表残留骗；32 位 Office 注册坏时自动改用 32 位 PowerShell。核实结果：这台其实两种都装了，开始菜单里有「Outlook (classic)」，只是没登录过邮箱。`plugins/README.md` 的插件表已加一行（4c2e850）。
- **故意没做**：发送 / 日历 / 联系人 / 规则；常驻 PowerShell（记在账本「点子」）。
- **他该看什么**：跑冒烟看 17 行 ✓；真机验证到公司电脑上照第 9 节做。
