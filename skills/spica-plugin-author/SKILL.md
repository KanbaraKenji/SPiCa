---
name: spica-plugin-author
description: Build a Spica plugin from scratch and install it into a running Spica. Use when the user wants to add a tool, a data source, a mail source, a skill, a slash command, a hook or a page (UI) to Spica, to wrap an internal service or script for Spica's agents, to turn on mock mode for a plugin, or to package (zip + SHA-256), install, test or debug a Spica plugin. Triggers include "Spica 插件", "给 Spica 加一个工具/页面", "做成插件装进 Spica", "plugin for Spica", "manifest.json for Spica".
---

# 写一个 Spica 插件并装进去

Spica 插件是一个文件夹：`manifest.json` 加上 MCP server（给 Agent 的工具）、可选的技能、命令、钩子、页面和模拟数据。打成 zip 后装进 Spica，启用时工具立刻出现，停用时全部撤掉。

本 skill 的脚本都在 `scripts/`，只用 Node 24 自带的模块，不用装依赖。下面 `<skill>` 指本 skill 的文件夹。

## 流程（按顺序做，每步做完再往下）

1. **读需求**，写下三件事给用户确认：插件名（小写字母、数字、`-`，以后不能改，它是工具名前缀）；要哪些工具；哪些工具会删数据、发东西、写外部系统（这些是**不可逆**的）。要界面就加上「页面放侧栏还是对话旁的面板」。
2. **生成骨架**：
   ```
   node <skill>/scripts/scaffold.mjs <插件名> --dir <放插件的文件夹> [--with skill,command,hook] [--with-ui]
   ```
   生成的插件已经能跑：4 个示例工具、错误码、模拟数据、测试，`--with-ui` 再带一个页面。
3. **实现工具**：改 `server/tools.js`（工具清单和参数）、`server/backend.js`（数据从哪来）、`server/errors.js`（错误码）。每个工具都要写清：
   - `description`：做什么、什么时候用、返回什么。模型只看得到这一句。
   - 参数：`inputSchema` 里每个字段的类型和说明，必填的写进 `required`。
   - 返回：JSON 对象（页面收到的是解析好的 `data`），字段名固定下来。
   - 是否不可逆：是的话写进 `manifest.json` 的 `permissions.irreversible`，并加 `annotations.destructiveHint: true`。
   - 要跑几分钟以上的（批量下载、导出）：干活时报进度，收到取消就停手，见 `references/manifest.md`「要跑很久的工具」。
   - 出错时抛 `PluginToolError('错误码')`，结果文字是 `[错误码] 一句中文人话`，说清怎么办。见 `references/errors.md`。
4. **模拟模式必须能跑通**：`SPICA_MOCK=1` 时全部工具都用 `mock/` 里的虚构数据回答，不连任何真服务。连不上真服务时返回 `[SERVICE_UNREACHABLE]` 并建议打开模拟模式。见 `references/mock-mode.md`。
5. **测试**：在插件文件夹里跑 `node --test`，为每个新工具加一条测试（模板在 `test/server.test.mjs`）。
6. **校验并打包**：
   ```
   node <skill>/scripts/check.mjs <插件文件夹>
   ```
   它会检查清单、在模拟模式下启动 server 列出工具、查密钥、跑测试，最后打出 `dist/<名字>-<版本>.zip` 和 `.sha256`。有 ✗ 就改，直到显示「可以装了」。
7. **装进 Spica**（详见 `references/connect.md`）：
   - Spica 开着，而且在 设置 › 常规 › 开发者 打开了「允许本机脚本连接 Spica」：直接跑 `node <skill>/scripts/install.mjs dist/<名字>-<版本>.zip`，脚本自己找到它。
   - 开关没开：请用户在 **设置 › 插件** 顶上的搜索框里粘贴 zip 的完整路径，左边列出这个插件后点它，再点右边的「安装」；第 8、9 步改成让用户在对话里试、再关掉开关看工具消失。
   - 开发时连自己起的服务：加 `--http <地址> --token-file <令牌文件>`，或 `--stdio <backend.json> --spica <Spica 源码文件夹>`。
   装完会列出新增的工具（`<插件名>__<工具>`）和页面。
8. **让 Agent 真调一次**：加 `--run "一句会用到这个工具的话"`，脚本经 `spica_run` 发出去，打印 Agent 调了哪些工具和回答。没调到你的工具，就回去改 `description`。
9. **停用验证全撤**：加 `--disable-after`，脚本停用插件并确认它的工具一个不剩。
10. **交付前自查**（下一节），再告诉用户包在哪、SHA-256 是多少、在 Spica 里怎么启用。

第 7–9 步可以合成一条：`install.mjs <zip> <连法> --run "…" --disable-after`。

## 交付前自查

- [ ] **没有密钥**：插件包里没有 API key、令牌、密码、私钥、`.env`（`check.mjs` 会查常见格式，但它不是全部）。需要凭据时，从 `SPICA_PLUGIN_DATA` 里的配置文件读，由插件自己的设置页通过 `services/` 里的工具保存，见 `references/internal-services.md`。**不要从环境变量读**：装进 Spica 后只传白名单变量，名字带 KEY、TOKEN、SECRET 的一律不传，`check.mjs` 看到会提醒。
- [ ] **没有写死公司专属的东西**：服务地址、部门名、项目代号不写进代码，放 `SPICA_PLUGIN_DATA` 里的配置文件；示例和模拟数据全是虚构的。
- [ ] **证书和代理没自己处理**：没有 `rejectUnauthorized: false`，没有打进包里的证书，也没自己读代理设置。这些由 Spica 代管（0.1.0-rc.2 起）。
- [ ] **用模型的写了 `permissions.model`**：理由一句话，上限合理；没有模型能力时工具会给提示，不会崩溃。
- [ ] **权限最小**：`permissions.workspace` 用得到才写 `read` / `write`；`permissions.hooks` 只写真用到的钩子类型；页面的 `permissions.tools` 只列页面要用的工具。
- [ ] **只写该写的地方**：自己的数据只写 `SPICA_PLUGIN_DATA`；下载、导出的文件只写用户在对话里点名的文件夹（从参数传进来、不猜、不出这个文件夹），结果里写出完整路径，覆盖已有文件的工具写进 `permissions.irreversible`。见 `references/hooks-permissions.md`「写文件」。
- [ ] **拉起的进程收得干净**：server 和辅助进程在 stdin 关闭时自己退出，辅助进程不用 `detached`；替用户打开、之后用户还要用的程序经一个马上退出的中间进程启动，当前文件夹不在插件文件夹里。见 `references/processes.md`。
- [ ] **只读的标了**：只查、只读、什么都不改的工具，在工具定义里写 `annotations: { readOnlyHint: true }`（MCP 规范的写法，不写就当 false）。没声明的，Spica 当成会有改动，调过它的那一轮回答不能「重新生成」。
- [ ] **不可逆都标了**：会删除、发送、提交、改外部系统的工具都在 `permissions.irreversible` 里。
- [ ] **日志不记正文**：stderr 只写工具名、错误码、耗时，不写邮件正文、文件内容、个人信息。
- [ ] **提示是中文人话**：每个错误码都有一句告诉用户「发生了什么、该怎么办」的中文。
- [ ] **模拟模式能跑通**，`node --test` 全过，`check.mjs` 显示「可以装了」。
- [ ] **图标是自己的**：`manifest.json` 的 `icon` 指向插件文件夹里的 `.svg`（不大于 64 KB），把脚手架给的那个换成这个插件自己的。见 `references/manifest.md`「插件图标」。
- [ ] 改了功能就改 `version`（三段数字），Spica 靠它判断更新。

## 带界面的插件

`--with-ui` 生成 `views/main.json` 和 `ui/`（`index.html`、`app.js`、`style.css`、`icon.svg`）。页面放在哪由 `placement` 定，两种：

| `placement` | 在哪 | 适合 |
|---|---|---|
| `sidebar`（默认） | 侧栏里一个入口，点开占主区域 | 完整的功能页：列表、表格、编辑 |
| `panel` | 对话旁边的右栏，一个标签 | 边聊边用的小工具：速记、状态、快捷操作；按 320px 宽设计 |

生成面板：`scaffold.mjs <名字> --with-ui --placement panel`。一个插件可以有多个页面（`views/` 里每个 `.json` 一个），例子：`plugins/example-notes` 的 Notebook（sidebar）和 Quick note（panel）。

页面跑在 Spica 的沙箱里：

- **没有 Node**：不能 `require`、不能读写文件。要读写数据，就在 server 里加工具，页面去调它。
- **只能加载本插件目录里的文件**：不能用 CDN，库文件也放进插件。
- **只能调本插件的工具**，写了 `permissions.tools` 就只能调列出的那几个；不可逆工具会先弹 Spica 的确认框。
- 用 Spica 注入的 `window.spica`：`callTool(工具原名, 参数)` → `{ content, data?, isError }`，`onEvent`，`theme`，`openFile`，`notify`。
- 颜色只用 `--spica-*` CSS 变量，明暗自动适配。只给页面用、不给模型用的工具，放 `services/`。

开发时不开 Spica 也能看页面：`node <skill>/scripts/preview.mjs <插件文件夹>`，在浏览器打开它打印的地址（暗色加 `?theme=dark`）。规则和 Spica 一样，背后是插件自己的 server（模拟模式）。详见 `references/ui.md`。

## 用 Spica 里配好的模型

插件要让模型写摘要、分类、改写时，不要自带 API key，借用户在 Spica 里配好的模型（MCP 的取样，sampling），详见 `references/model.md`：

- 清单写 `permissions.model: { "reason": "一句为什么", "max_usd_per_day": 0.2 }`。安装和启用时会把理由给用户看，每天的上限缺省 0.5 美元，用户可以在插件页调低。
- 用官方 SDK 时调 `server.createMessage({ messages, maxTokens, systemPrompt })`；不用 SDK 的写法见 `plugins/example-notes` 的 `summarize_note`。
- 先看 `initialize` 里有没有 `capabilities.sampling`，没有就给一句提示：可能没申请、用户把上限调成 0，或者 Spica 太旧（rc.2 之后的版本才有）。
- 被拒绝时是 `-32000` 错误，`data.code` 说明原因（`no_model`、`budget` 等），要转成一句人话。
- 页面脚本不能直接用，要用就调自己 server 的工具。

## 连内部接口

包公司内部服务的插件，先读 `references/internal-services.md`。要点：

- **地址和凭据**放 `SPICA_PLUGIN_DATA/config.json`。用户在插件**自己的页面**里填，页面经 `services/` 里的工具保存（模型看不到这些工具）。Spica 没有统一的插件设置表单。
- **证书和代理由 Spica 代管**（Spica 0.1.0-rc.2 起；rc.1 和更早的版本不代管，插件连公司内网会报证书错误）：插件进程获得的代理和信任名单和 Spica 自己的一样，Node 里直接用 `fetch` / `https`。用户改了网络设置，插件 server 会自动重启一次，之后的请求就按新设置走。
- **工具按用户要办的事设计**，不是一个接口一个工具，一个插件十个以内。
- **应用改了名**：插件不用改，`install.mjs` 加 `--app <应用名>`。

## 参考

| 文件 | 内容 |
|---|---|
| `references/manifest.md` | 目录结构、`manifest.json`（含插件图标 `icon`）、`mcp/*.json`、`views/*.json` 字段 |
| `references/errors.md` | 工具错误码的写法；Spica 装插件、调页面时给的提示和怎么改 |
| `references/hooks-permissions.md` | 钩子类型、权限声明、不可逆确认 |
| `references/mock-mode.md` | 模拟模式怎么写 |
| `references/mail.md` | 声明「这个插件是邮件来源」 |
| `references/ui.md` | 页面：声明、`window.spica`、主题变量、沙箱、预览 |
| `references/connect.md` | 怎么连上 Spica（桌面版开关、HTTP + 令牌 / stdio、改了名的应用），装不上时怎么办 |
| `references/model.md` | 借用 Spica 里配好的模型：申请、调用、选模型、被拒绝时怎么说 |
| `references/internal-services.md` | 连内部接口：地址和凭据放哪、设置页写法、证书和代理、工具怎么设计 |
| `references/processes.md` | 插件拉起的进程：Spica 怎么结束 server，辅助进程怎么退出，替用户打开的程序怎么独立启动，重的辅助进程空闲就退 |

更完整的说明在 Spica 仓库的 `docs/plugins/authoring.md`（作者指南）和 `docs/design/plugins.md`（设计），能跑的例子在 `plugins/example-notes`（带页面）。
