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
   - 返回：JSON 对象（页面拿到的是解析好的 `data`），字段名固定下来。
   - 是否不可逆：是的话写进 `manifest.json` 的 `permissions.irreversible`，并加 `annotations.destructiveHint: true`。
   - 出错时抛 `PluginToolError('错误码')`，结果文字是 `[错误码] 一句中文人话`，说清怎么办。见 `references/errors.md`。
4. **模拟模式必须能跑通**：`SPICA_MOCK=1` 时全部工具都用 `mock/` 里的虚构数据回答，不连任何真服务。连不上真服务时返回 `[SERVICE_UNREACHABLE]` 并建议打开模拟模式。见 `references/mock-mode.md`。
5. **测试**：在插件文件夹里跑 `node --test`，为每个新工具加一条测试（模板在 `test/server.test.mjs`）。
6. **校验并打包**：
   ```
   node <skill>/scripts/check.mjs <插件文件夹>
   ```
   它会检查清单、在模拟模式下启动 server 列出工具、查密钥、跑测试，最后打出 `dist/<名字>-<版本>.zip` 和 `.sha256`。有 ✗ 就改，直到显示「可以装了」。
7. **装进 Spica**（详见 `references/connect.md`）：
   - Spica 开着，而且在 设置 › 常规 › 开发者 打开了「允许本机脚本连接 Spica（开发者）」：直接跑 `node <skill>/scripts/install.mjs dist/<名字>-<版本>.zip`，脚本自己找到它。
   - 开关没开：请用户在 **设置 › 插件** 里粘贴 zip 的完整路径安装，第 8、9 步改成让用户在对话里试、再关掉开关看工具消失。
   - 开发时连自己起的服务：加 `--http <地址> --token-file <令牌文件>`，或 `--stdio <backend.json> --spica <Spica 源码文件夹>`。
   装完会列出新增的工具（`<插件名>__<工具>`）和页面。
8. **让 Agent 真调一次**：加 `--run "一句会用到这个工具的话"`，脚本经 `spica_run` 发出去，打印 Agent 调了哪些工具和回答。没调到你的工具，就回去改 `description`。
9. **停用验证全撤**：加 `--disable-after`，脚本停用插件并确认它的工具一个不剩。
10. **交付前自查**（下一节），再告诉用户包在哪、SHA-256 是多少、在 Spica 里怎么启用。

第 7–9 步可以合成一条：`install.mjs <zip> <连法> --run "…" --disable-after`。

## 交付前自查

- [ ] **没有密钥**：插件包里没有 API key、令牌、密码、私钥、`.env`（`check.mjs` 会查常见格式，但它不是全部）。需要凭据时让用户在本机配置，或从环境变量读。
- [ ] **没有写死公司专属的东西**：服务地址、部门名、项目代号不写进代码，放配置或环境变量；示例和模拟数据全是虚构的。
- [ ] **权限最小**：`permissions.workspace` 用得到才写 `read` / `write`；`permissions.hooks` 只写真用到的钩子类型；页面的 `permissions.tools` 只列页面要用的工具。
- [ ] **不可逆都标了**：会删除、发送、提交、改外部系统的工具都在 `permissions.irreversible` 里。
- [ ] **日志不记正文**：stderr 只写工具名、错误码、耗时，不写邮件正文、文件内容、个人信息。
- [ ] **提示是中文人话**：每个错误码都有一句告诉用户「发生了什么、该怎么办」的中文。
- [ ] **模拟模式能跑通**，`node --test` 全过，`check.mjs` 显示「可以装了」。
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

## 参考

| 文件 | 内容 |
|---|---|
| `references/manifest.md` | 目录结构、`manifest.json`、`mcp/*.json`、`views/*.json` 字段 |
| `references/errors.md` | 工具错误码的写法；Spica 装插件、调页面时给的提示和怎么改 |
| `references/hooks-permissions.md` | 钩子类型、权限声明、不可逆确认 |
| `references/mock-mode.md` | 模拟模式怎么写 |
| `references/mail.md` | 声明「这个插件是邮件来源」 |
| `references/ui.md` | 页面：声明、`window.spica`、主题变量、沙箱、预览 |
| `references/connect.md` | 怎么连上 Spica（HTTP + 令牌 / stdio），装不上时怎么办 |

更完整的说明在 Spica 仓库的 `docs/plugins/authoring.md`（作者指南）和 `docs/design/plugins.md`（设计），能跑的例子在 `plugins/example-notes`（带页面）。
