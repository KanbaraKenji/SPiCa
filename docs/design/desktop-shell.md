# 桌面外壳设计（`apps/desktop`）

> 状态：U1、U2、U3 完成，都在真内核上实测过（DeepSeek）：逐字流出、提问卡、插话、两个子任务并行再汇总、关掉重开都还在（2026-11-09）。
> 需求来源：立项书「定位」「界面」「数据与外壳」「硬环境约束」「首版验收」；界面禁区 `~/.claude/hoshi-ui-bans.md`。

## 1. 布局与区域

```
┌ 左侧栏 264px（通到窗口顶） ┬ 标题栏：当前会话标题（子会话前面带「项目 ›」）……… [详情开关][系统按钮] ┐
│ [Spica 横标]     [侧栏开关] ├──────────────────────────────────────────┬──────────────────────────┤
│ 新对话                      │  对话流（最宽 760px，居中）              │ 右侧栏 300px（详情）       │
│ 对话：顶层会话              │  ……                                     │ 类型 / 属于 / 文件夹       │
│ 项目：项目经理              │                                          │ 工具调用                   │
│   └ 子任务（层数不限）      │  输入框                                  │ 文件 / 花费                │
│ 设置                        │                                          │                            │
└─────────────────────────────┴──────────────────────────────────────────┴────────────────────────────┘
```

- 外框对标 Claude Desktop（他的原话「外框区域要划分干净」「左侧栏的范围是到最顶部的」「参考claude」）：左侧栏通到窗口最顶，左上角是 Spica 横标、右边是收起侧栏的按钮；标题栏只盖主窗和详情，底下一条横线从侧栏边拉到窗口最右（系统按钮区高度少 1px，线在按钮下面也不断）；三栏之间是到底的竖线，交点直角。侧栏收起时，花标和展开按钮出现在标题栏最左边。
- 标题栏是自画的（`titleBarStyle: 'hidden'` + Windows 的 `titleBarOverlay`），系统的最小化/最大化/关闭按钮由 Windows 画，颜色跟皮肤同步；右侧用 CSS `env(titlebar-area-*)` 给系统按钮留位置。
- **窗口变窄时不挤对话**：先收右侧栏，再收左侧栏（`shell/layout.ts`，主窗最窄 440px）。被收起的栏点开关时浮在主窗上面（带遮罩，Esc 或点空白处关），不改你保存的开关状态。宽度够了自动回到并排。
- 快捷键：Ctrl+B 侧栏，Ctrl+Alt+B 详情，Esc 关浮层 / 关设置。
- 左侧栏是会话树：「对话」放和助理的对话，「项目」放项目经理；任何会话开出的子任务都挂在它下面，层数不限。行尾是状态标记；收起时换成下面所有子任务的摘要（「1 个等你 · 2 个在跑」）。下面有东西在跑、或者正打开着其中一个时，默认展开。
- 打开时先播品牌包的开机画面（`SpicaSplash`），三栏在它底下同时就绪；会话列表读完就收尾淡出。截图脚本不播。
- 入口自问（立项书那句）：设置只有左下角一个入口（另外只在「一个模型都没配」时，空对话页给一个「去设置模型」，直达同一页）；新对话只在左侧栏顶部；项目行点名字进项目经理的对话，点前面的箭头只展开收起，两个动作分开、互不误触；子会话的标题栏带「项目 ›」可以一步回到项目。

## 2. IPC 适配层（换真内核只动一个文件）

```
renderer ──window.spica──► preload ──ipcMain──► main ──AgentBackend──► CoreBackend（@spica/core 的 Runtime）
   │  (DesktopBridge)                              │                  FakeBackend（截图、测试、没配模型时）
   └◄────────── spica:agent-event（CoreEvent）◄─────┘
```

- 合同用 `@spica/protocol`（内核发布）：`AgentApi` 是命令，`CoreEvent` 是事件。外壳自己的东西（设置、开文件）在 `src/shared/bridge.ts` 的 `DesktopBridge` 里，继承 protocol 的 `SpicaBridge`。
- 主进程 `ipcMain.handle('spica:agent', method, args)` 只放行 `AgentApi` 的 11 个方法名，其余一律拒绝。
- 后端选择只在 `src/main/backend/index.ts`：`SPICA_BACKEND=fake|core` 强制；不指定时截图脚本用假后端，平常运行一律用真内核。一个模型都没配时，空对话页写「还没有配置模型」并给一个「去设置模型」按钮（直接打开设置的「模型」页）。`AgentBackend = AgentApi + onEvent + dispose + configure`。
- 真内核 `CoreBackend`：`new Runtime({ store: new SqliteStore(userData/spica.db) })` + `runtime.restore()` + `createAgentApi(runtime)`，事件直接转发 `runtime.events`。会话、历史、等你回答 / 确认的事都在 SQLite 里，正常关闭或强杀后重开都在；跑到一半被打断的会话在对话末尾显示「上次没做完就中断了 [继续]」。
- 模型从两处来：设置页保存的（见第 6 节），和开发者仓库根 `.env.local` 里的（`SPICA_OPENAI_*` / `SPICA_ANTHROPIC_*`，只在没打包时读，由主进程 `util.parseEnv` 解析成普通对象，不写进 `process.env`、不进日志、不进渲染层；设置页里显示为只读的「开发用模型（.env.local）」）。新会话用「默认」那一个；保存、删除、改默认都立即生效（`runtime.addProvider`），不用重开。
- 会话默认工作文件夹：`文档\Spica`（第一次用真内核时创建）。
- 开发期花费上限沿用内核文档：Anthropic 总计 100 USD、单次 2 USD、单轮 1 USD。
- 假后端 `FakeBackend`：不联网、不碰磁盘；带一套虚构的演示数据（2 个对话、2 个项目、4 个子任务，覆盖空闲 / 思考 / 调工具 / 排队 / 等你回答 / 已完成）；`speed: 0` 时脚本瞬间跑完（测试和截图用）。发消息里带「发送 / 确认」走确认流程，带「问 / 选」走提问流程，其余走「读文件 → 回答 → 建议」。

## 3. 事件到界面的映射

| 事件 | 界面 |
|---|---|
| `message`（user / steer） | 一条用户消息（插话带「插话」小标，虚线边） |
| `text.delta` | 逐字追加到当前回答的正文（Markdown 渲染） |
| `thinking.delta` | 「正在思考 / 思考过程」可折叠行，默认收起 |
| `tool.call` / `tool.start` / `tool.end` | 工具行：动词 + 对象（「读取文件 需求说明.docx」）+ 用时；连续几个合成一行「调用了 N 个工具」，点开看每个的结果 |
| `confirm.request` / `confirm.resolved` | 确认卡：只写要确认的是什么，「拒绝 / 允许」 |
| `ask.request` / `ask.resolved` | 提问卡：选项按钮 + 自由回答 |
| `suggest.actions`（工具 `suggest_actions`） | 操作建议卡：点一条就把它对应的话发出去 |
| 回答里 `read_file / write_file / edit_file` 的 `path` | 回答末尾的文件卡（点开用系统默认程序打开）；右侧栏「文件」同源 |
| `status` / `queue` | 回答末尾的状态行：花标动效 + 本轮计时 + 阶段文案（排队中，前面还有 N 个 / 思考中 / 正在回复 / 正在读取文件 / 等你确认 / 等你回答）；结束后停 1.4 秒「已完成 · 用时」再收起 |
| `cost`（session）/ `status` | 侧栏状态标记、详情的花费 |
| `child.spawned` / `session.renamed` | 侧栏会话树刷新 / 改名 |
| `message`（relay / report，带 `ChildNoteMeta`） | 子会话卡片：「X 做完了，回报」「你在那边说」「那边定了」，点名字进那个子会话 |
| `run.end` | 重新取一次历史（`getMessages` + `getPending`）作准；测试保证流式结果与历史重建一致，不跳 |
| `error` / `budget.stop` | 对话里一行红底人话提示（401、429、余额、连不上等翻成中文，见 `humanError`）；内核自己在重试的（`retryable`）不打扰；命令失败（IPC 抛错）在主窗顶部弹提示，可关 |

- 内部消息 → 界面的规则全在 `store/transcript.ts`（纯函数，有测试）：一轮里的多条助手消息合成一段回答；工具结果第一行的取数时间不显示。
- 侧栏状态标记：转圈 = 在跑；虚线圈 = 排队；琥珀点 = 等你；红点 = 出错 / 中断；绿勾 = 子任务完成；空闲不显示。项目收起时在行尾写「1 个等你 · 1 个在跑 · 1 个排队」，展开时不重复。

## 4. 皮肤 token

- 一个皮肤只有两个输入：**底色**和**强调色**（`shared/skin.ts`）。其余 20 多个 token 全部推出来：侧栏底、卡片底、浮层底、输入框底、两档边线、悬停 / 按下、正文 / 次要 / 更淡三档字色、强调色做字时的可读版、强调色上的字色、浅强调底、选中色、危险 / 警告 / 成功及其浅底、遮罩、阴影。
- 明暗不靠开关，靠底色算：哪种字色在底色上对比度高就用哪种；底色是中灰时字色推到纯黑或纯白。测试锁住：正文 ≥ 4.5:1、次要字 ≥ 4.5:1、更淡字 ≥ 2.5:1、强调色文字 ≥ 3:1。
- 内置三个选项：跟随系统、浅色、深色。自定义皮肤：设置 › 外观 › 新建皮肤（从当前皮肤复制），改名称、底色、强调色，改动立即生效并自动保存；删除要确认「删除皮肤「X」？」。
- 渲染层把 token 写到 `:root` 的 CSS 变量；主进程同一套算法算窗口底色和系统按钮颜色，并把 `nativeTheme.themeSource` 设成皮肤的明暗，滚动条、取色器等原生部件跟着变。
- 花标长瓣用 `--spica-accent`，跟随强调色。
- 首帧不闪：`main.tsx` 先 `await getShellState()` 写好 token 再渲染，窗口 `ready-to-show` 才显示。

## 5. 缩放

- 整窗缩放用 Electron 的页面缩放（`webContents.setZoomFactor`），不用 CSS `zoom` / `transform`，所以弹窗、浮层、取色器的位置天然对得上。
- 档位：67 / 75 / 80 / 90 / 100 / 110 / 125 / 150 / 175 / 200%。
- Ctrl+滚轮、Ctrl+= / Ctrl+- / Ctrl+0：页面里拦下（`shell/zoomInput.ts`，滚轮一格一档，触控板小幅滚动攒够再算一档），交给主进程按档位改并保存；主进程的 `before-input-event` 和 `zoom-changed` 留作兜底。应用菜单已去掉，避免默认菜单的缩放快捷键另走一套。已在真窗口实测：滚轮上两格 125%、下一格 110%，Ctrl+= / - / 0 按档走，设置文件里跟着变。
- 缩放值存进设置，下次启动 `webPreferences.zoomFactor` 直接用；标题栏系统按钮的高度随缩放同步（40px × 缩放）。已在真窗口 150% 下截屏核对过系统按钮和自画标题栏对齐。

## 6. 设置存哪

- `%APPDATA%\Spica\settings.json`（主进程读写，先写临时文件再改名，写坏了读到的是默认值）。渲染层不碰 `localStorage`。字段：`skin`、`customSkins`、`zoom`、`panels.left/right`。
- 设置分两页：外观（皮肤、缩放）、模型。
- 模型存 `%APPDATA%\Spica\providers.json`。三种表单：OpenAI 兼容（接口地址、API Key、模型）、Anthropic（API Key、接口地址可留默认、模型）、WSO2 网关（网关地址、取 token 地址、Client ID、Client Secret、Scope 可选、模型）；三种都有强模型（可空）、同时请求数、每分钟请求数（空 = 不限）。
- 密钥（API Key / Client Secret）用 Electron `safeStorage`（Windows DPAPI，按当前用户加密，不需要管理员）存密文；主进程从不把密钥发回界面，界面只知道「已保存」。系统不能加密时拒绝保存并说明。
- 「测试连接」是真的（`main/providers/real-tester.ts`）：先查表单，再用表单里的配置向模型发一次极小的请求（不重试、20 秒超时，什么都不保存），结果用人话说（密钥不对、连不上、找不到模型……）。截图和测试用假测试器，不联网。内核出探针接口（M5）后换成它，只改这一个文件。
- 默认模型：第一次保存时如果还没有默认就设为默认，已有（包括开发用模型）就不抢；任何一行都能「设为默认」。

## 7. 第一次用（UX 复查后定的）

- 「新对话」只是清空主窗；发第一句话时才建会话，所以连点不会多出空会话。
- 没配模型时：空对话页写「还没有配置模型 [去设置模型]」；硬发消息会提示「还没有配置模型，先到 设置 › 模型 里添加一个」。
- 所有报错先翻成人话（`shared/errors.ts`，主进程和界面共用）；提示条换页面就清掉，8 秒后自动消失。
- 没打开对话时右侧详情是空的，不放一列「—」。
- 拿不准的 4 处（设置页返回、模型表单高级项、开机画面时长、表单离开提示）做成了点选页，等他说「这版可以了」再给他点。
- 界面禁区逐条过：无 emoji；无下划线（设置页标签改成填色块）；不能点的都不像按钮（「默认」「插话」是纯文字）；空值是「—」或不显示；术语只在模型表单里用网关管理员给的字段名（API Key、Client ID 等）；同一件事一处（详情不再重复状态）；不闪不跳（窗口缩放、改尺寸时对话贴底）；确认框只写对象（「删除模型「X」？」）。「不让人干等」与开机画面的冲突放进点选页由他定。

## 8. 截图脚本

```powershell
npm run shots -w @spica/desktop                 # 对话页、设置 › 外观、设置 › 模型 × 浅/深 × 480×360、900×600、1280×800、1920×1080 × 100%、150%，共 48 张
npm run shots -w @spica/desktop -- main         # 只出某几页，逗号分隔（main / settings / models）
```

- 输出 `docs/screenshots/shell/{视图-}{皮肤}-{宽}x{高}-z{缩放}.png`。
- 在真窗口里截（真实字体、DPI、布局），不读不写你自己的设置（用临时设置目录），全程用假后端，结果稳定可比。超过 2 分钟自动退出。
- 开发开关：`SPICA_THEME=dark|light`、`SPICA_CAPTURE=<png>`（截一张就退）、`SPICA_SHOTS=<目录>`、`SPICA_USER_DATA=<目录>`（换一个设置目录做手动检查）。

## 9. 测试

- 纯函数：皮肤对比度、设置清洗、缩放档位、三栏收放、事件 → 界面映射（含「流式结果 = 历史重建」）、假后端的流程（确认、提问、插话、中止）。
- 组件（jsdom）：输入框（Enter 发送、输入法组字时回车不发送、Shift+Enter 换行、运行中有停止）、提问卡 / 确认卡 / 建议卡 / 文件卡 / 工具行折叠、外观设置（换皮肤、新建、改色、非法色值回退、删除要确认、缩放）、侧栏（打开会话、展开收起、项目摘要）。

## 10. 故意没做的事

- 分区缩放（左栏 / 主窗 / 右栏各自缩放）：立项书写「之后」。
- 侧栏拖拽改宽度、会话改名 / 删除 / 搜索：没人要，入口先不加（`renameSession` 和 `session.renamed` 已接上，只差入口）。
- 会话名：内核新会话的名字是空的，界面上用第一句话当名字。
- 花标、状态动效、开机画面全部来自 `@spica/brand`，外壳不自己画；窗口 / 任务栏图标用 `resources/branding/png/spica-win-{dark,light}.png`，按 Windows 任务栏明暗选。
- 文件卡只认 `read_file / write_file / edit_file` 的 `path`，模型在正文里提到的文件不会变成卡片。
- `body` 默认不可选中（界面像应用不像网页），对话正文、输入框、路径单独打开了选中。
- 任务栏状态灯、彩蛋：不在三个里程碑里。

## 11. 交接（2026-11-09 用量快到上限时写）

**已提交、都是绿的**：U1–U3、外框、UX 复查修正、file.card / 回报卡 / 建议卡（含重开后从 meta 重建）、提取器接线（a83e0a1）、3ea4bbb 为止。

**做到一半、没提交**：设置 › 插件 页（「插件系统」2caf365 的接口，见 docs/design/plugins.md 第 9 节）。代码已写完、typecheck / lint / 现有测试都过，但还没在真窗口里装过插件，所以没提交。涉及的文件：
- 新文件：`apps/desktop/src/shared/plugins.ts`（界面看到的类型和命令）、`src/main/plugins/service.ts`（`RealPluginService` 包 PluginManager；`FakePluginService` 给截图）、`src/renderer/src/settings/Plugins.tsx`（列表、启用开关、模拟模式、安装、更新、退回、删除）。
- 改动：`src/main/index.ts`（插件根 `%APPDATA%\Spica\plugins`、IPC、启动时 `start()`、退出前停插件进程）、`src/main/backend/index.ts`（返回 runtime 类型）、`src/preload/index.ts`、`src/shared/bridge.ts`、`src/shared/ipc.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/settings/SettingsView.tsx`（第三个标签「插件」）、`src/renderer/src/styles.css`（开关、插件卡片）、`apps/desktop/package.json` + 根 `package-lock.json`（加 `"@spica/plugins": "*"`，两者要同一个提交）。

**下一步第一件事**：`npm run build -w @spica/desktop` 后用真内核开窗口，设置 › 插件 里填 `K:\unnamed\plugins\example-notes` 点安装；确认列表出现「Notes (example)」、展开看到工具、关掉开关后工具变 0（J6），打开再回来；退回 / 删除各点一次。截图明暗各一，补 `Plugins.test.tsx`（假 api），然后连同上面的文件一个提交。

**还没开始**：项目入口（等内核 M4 的 ProjectApi 进 AgentApi，协议现在还在改）。点选页 `ledger-briefs/pages/shell-ux.html` 等他说「这版可以了」再发。
