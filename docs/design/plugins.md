# 插件系统设计（`@spica/plugins`）

> 状态：首版完成（2026-11-09）。插件文件夹格式、启用 / 停用全撤销、Node 与自带可执行文件两种 MCP server、崩溃重启、模拟模式、打包校验、共享盘 / HTTP 分发与更新、回滚都已做通；示例插件 `plugins/example-notes` 跑通 J6。
> 需求来源：立项书「硬规则」「Harness」「插件」「首版验收 J6」「硬环境约束」。内核侧接口见 `agent-core.md` 第 7 节（钩子）、第 8 节（工具与确认，含 MCP 客户端）。

## 1. 对标与取舍

| 参照 | 拿了什么 | 没拿什么 |
|---|---|---|
| Claude Code / DeepSeek Harness 的插件文件夹 | 一个目录一个插件，`skills/`、`commands/`、MCP 声明、`hooks/` 按目录放；技能用 `SKILL.md`（frontmatter 写 description），命令是 Markdown 模板（`$ARGUMENTS`） | 钩子不是 shell 命令，而是进程内的 JS 模块（我们的钩子要改请求和响应，shell 钩子做不到，也会弹窗） |
| Claude Desktop 的 MCPB | 清单文件叫 `manifest.json` 放根上；包就是 zip；Node 类 server 用宿主自带的 Node；依赖（node_modules）打进包里，用户什么都不用装 | 不用 `.mcpb` 扩展名、不做 `user_config` 表单（以后需要再加） |

## 2. 目录格式

```
<插件>/
  manifest.json             清单（必需）
  skills/<id>/SKILL.md      技能：frontmatter 的 name、description + 正文
  commands/<id>.md          命令：frontmatter 的 description、argument-hint + 正文模板
  mcp/<id>.json             MCP server 声明（工具给模型用）
  services/<id>.json        常驻进程声明（也是 MCP server，默认不把工具给模型）
  hooks/*.js | *.mjs        代码钩子（ESM，默认导出钩子对象或工厂函数）
  views/<id>.json           插件自带的页面（外壳在沙箱里渲染）
  mock/…                    模拟数据（约定，宿主不读）
  其余文件                  server 代码、可执行文件、node_modules 等
```

### 清单 `manifest.json`

| 字段 | 必填 | 说明 |
|---|---|---|
| `manifest_version` | 是 | 现在只有 `1` |
| `name` | 是 | 小写字母、数字、`-`，2–24 字符，以字母开头。也是工具名前缀 |
| `version` | 是 | semver，如 `1.2.3` |
| `description` | 是 | 一句话 |
| `author` | 是 | `{ "name": … }` 或字符串 |
| `display_name` | 否 | 界面上显示的名字，默认用 `name` |
| `icon` | 否 | 插件自己的图标，设置 › 插件 的列表和详情里用；没有时外壳用名字的第一个字加色块。插件文件夹里的 `.svg` 相对路径，或浅色、深色皮肤各一款 `{ "light": …, "dark": … }`（只给一款时两种皮肤都用它），规矩同视图的 `icon`（不许 `..`、绝对路径，文件要存在），另加不大于 64 KB（`ICON_MAX_BYTES`）。写错是 error，不装。`describe()` 给 `{ light, dark }`，相对安装目录的路径（一款时两个一样）；外壳读成 `data:` 图片随列表送去，界面里只用 `<img>` 显示、按当前皮肤显示其中一款，换皮肤时跟着换，SVG 里的脚本不执行 |
| `license` | 否（警告） | SPDX 写法 |
| `compatibility.spica` | 否（警告） | 兼容范围：`>=0.1.0 <1.0.0`、`^0.1.0`、`~0.1.0`、`*` |
| `permissions.network` | 否 | 插件进程会访问的主机名单；现在只展示给用户，不拦截 |
| `permissions.workspace` | 否 | 对会话工作文件夹（项目文件夹）的访问：`none`（默认）/ `read` / `write`；现在只展示，第 7 节写了以后怎么拦 |
| `permissions.irreversible` | 否 | 不可撤销的工具（写 server 里的原名，mcp/ 和 services/ 的都算），调用前一律要用户确认 |
| `permissions.hooks` | 否 | 钩子模块允许挂哪几类：`inject`、`beforeRequest`、`afterResponse`、`beforeTool`、`afterTool`。没声明的一律不挂 |
| `permissions.model` | 否 | 借用户配好的模型（MCP 取样）：`{ "reason": "一句为什么", "max_usd_per_day": 0.2 }`。`reason` 必填（安装、启用时给用户看，第一次用不再确认），上限缺省 0.5 美元/天。起 server 时 manager 在 `connectMcp` 的配置里加 `sampling: { pluginId, maxUsdPerDay }`，上限取清单值和用户在插件页设的值中较小的；用户设 0 或没声明就不传，server 拿不到 `capabilities.sampling`。用户改上限会重启这个插件的 server |
| `mock` | 否 | `{ "supported": true, "description": "…" }` |
| `mail` | 否 | 这个插件是邮件来源：`{ "list_tool": "list_messages", "read_tool": "read_message" }`（server 里的原名）；可选 `server`（有多个 MCP server 时必填）、`list_args`、`fields`（列表结果字段名和内核默认不同时）。启用时插件包调 `runtime.mail.addSource({ id: 插件名, listTool: '<server名>__list_messages', … })`，停用时撤掉；部署配置里不用再写带前缀的工具名 |

校验从不抛异常，返回问题列表：每条带「哪个文件 · 哪个字段」和一句中文人话（例：`manifest.json · version：版本号「1.0」不合格，应该像 1.2.3 这样三段数字。`）。有 error 就不装、不启用；warning 只展示。

### MCP server / 常驻进程声明 `mcp/<id>.json`、`services/<id>.json`

```json
{
  "runtime": "node",
  "entry": "server/index.js",
  "args": [],
  "env": { "LOG_LEVEL": "info" },
  "timeout_seconds": 30,
  "max_call_seconds": 3600,
  "restart": { "max_restarts": 3, "window_seconds": 60 },
  "expose_tools": true
}
```

- `runtime`：`node`（用宿主的 Node 跑 `.js/.mjs/.cjs`）或 `binary`（插件自带的可执行文件）。写 `python` 会得到提示「这一版只支持自带可执行文件」。
- `entry` 必须是插件文件夹里的相对路径；绝对路径、`..`、盘符一律拒绝。`binary` 不能是 `.cmd/.bat/.ps1/.vbs`（会弹控制台）。
- `env` 不能自己设 `SPICA_` 开头的变量。
- `expose_tools`：`mcp/` 默认 true，`services/` 默认 false。
- `timeout_seconds`：多久没有结果、也没有进度就算这次调用失败（缺省 60）。`max_call_seconds`：一直在报进度也最多等多久（缺省 3600，必须大于 0）。内核调工具时带 progressToken，收到这次调用的进度就重新计时；超时或用户停止时给 server 发 `notifications/cancelled`。插件页面直接调工具（`callPluginTool`）也一样，没有另外写死的时限；后台方法 `pluginViewCall` 可以带外壳自己定的 `callId`，页面关掉或重新加载时外壳调 `pluginViewCancel({ callId })` 停掉它，server 会收到取消。写法见作者指南 2c 节。
- `concurrency`：这个 server 同时最多处理几个工具调用（1 或更大的整数，缺省不限），多出来的按先后排队；对话和插件页面走同一个队列；排队的时间不算进 `timeout_seconds` 和 `max_call_seconds`；排着时被停止或对话被删就离开队列，server 停用或崩溃时排着的都报错。界面上还看不出「在等」（内核有 `McpStdioClient.waiting`，要给界面得加 protocol 的事件）。跨应用的独占由插件自己用系统的锁（作者指南 2e 节）。

### 钩子模块 `hooks/*.js`

```js
/** @type {import('@spica/plugins/types').HookModule} */
export default (ctx) => ({
  inject() {
    return [{ position: 'system:after', text: 'Notes plugin is active.' }];
  },
});
export const priority = 100; // 可选，小的先跑
```

- 默认导出钩子对象，或接收 `PluginContext`（name、version、pluginDir、dataDir、`mock()`、`log()`）的工厂。
- 钩子类型和参数就是内核的 `Hooks`（`agent-core.md` 第 7 节），六个注入位置照用。
- 只收 ESM `.js/.mjs`；放 `.ts` 会得到「先编译成 .js」的警告。Electron 45 自带的 Node 24.22 其实能跑 TS，但不对插件作者承诺，免得以后换运行时出问题。

### 视图 `views/<id>.json`（插件自带的页面）

```json
{
  "title": "Notebook",
  "entry": "ui/index.html",
  "placement": "sidebar",
  "icon": "ui/icon.svg",
  "permissions": { "tools": ["list_notes", "read_note", "write_note", "delete_note"] }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 侧栏 / 面板上显示的名字 |
| `entry` | 是 | 插件目录里的 `.html`，相对路径，不许 `..`、绝对路径，文件要存在 |
| `placement` | 否 | `sidebar`（默认，侧栏里一个入口）/ `panel`（对话旁边的面板） |
| `icon` | 否 | 插件目录里的 `.svg` |
| `permissions.tools` | 否 | 页面能调的本插件工具（server 里的原名，不带前缀）；不写 = 本插件全部工具，常驻进程的工具也算 |

视图文件名（不含 `.json`）就是视图 id：小写字母、数字、`-`。

**外壳怎么渲染**（和桌面外壳对好的约定，2026-11-10）：
- 页面跑在沙箱里：没有 Node；自定义协议 `spica-plugin://<插件>/<路径>`，每次取文件都问 `pluginViewFile`，只给本插件目录里的文件；CSP `default-src spica-plugin:`，样式另放 `'unsafe-inline'`。
- 外壳注入 `window.spica`：`callTool(工具原名, 参数)` → `{ content, data?, isError }`；`onEvent(fn)`（`{type:'theme'}`、`{type:'plugin.changed'}`），返回取消函数；`theme` → `{ mode: 'light' | 'dark' }`；`openFile(路径)`（只限本插件目录里的文件或这次会话见过的文件，在右栏预览）；`notify(文字, { kind? })`。
- 主题：外壳往页面根元素注入 9 个 CSS 变量 `--spica-bg`、`--spica-surface`、`--spica-fg`、`--spica-muted`、`--spica-border`、`--spica-accent`、`--spica-danger`、`--spica-font`、`--spica-radius`，换明暗或皮肤时重新注入并发 `theme` 事件。
- 调工具：外壳把 `callTool` 转给后端 `pluginViewCall`。插件包检查插件已启用、视图存在、工具是本插件的且在 `permissions.tools` 里；然后交给内核 `runtime.callPluginTool(插件, 完整工具名, 参数, { confirmed })`：不走模型，但**钩子照常生效**（例如 Outlook 插件把附件限制在项目文件夹里的 `beforeTool`），调用留痕（发起方 `view:<插件>`）。需要确认时（`permissions.irreversible` 经插件包的权限钩子返回 confirm、MCP 的 `destructiveHint`、或别的钩子要求确认），没带 `confirmed: true` 的调用什么都不执行，返回 `[CONFIRM_REQUIRED] 原因`；外壳弹 Spica 自己的确认框（「<插件名> 要执行 <工具>，确认吗？」），同意后带 `confirmed: true` 再调。钩子拒绝时返回钩子自己的错误码（如 `[PATH_NOT_ALLOWED]`），没有码时是 `[BLOCKED]`。常驻进程的工具对模型隐藏，但本插件的页面可以调（权限钩子认得 `view:<插件>` 发起的调用）。没有 `callPluginTool` 的旧内核退回 `invokeTool`（不走钩子）。
- 失败结果的 `content` 以错误码开头：`PLUGIN_DISABLED`、`VIEW_NOT_FOUND`、`TOOL_NOT_FOUND`、`TOOL_NOT_ALLOWED`、`CONFIRM_REQUIRED`、`BLOCKED`（钩子拒绝且没给码）、`UNSUPPORTED`；工具自己报的错原样返回。
- 停用：`views()` 不再列它，`pluginViewFile` 回 `null`，外壳收到 `plugins.changed` 关掉页面。

## 3. 扩展点总表

| 扩展点 | 进内核的方式 | 来源 |
|---|---|---|
| 技能 | 插件包代注册：一个 `inject` 钩子（`system:after` 放技能目录）+ 一个工具 `<插件>__skill`（按 id 取正文）。模型先看目录，用到时再取全文，上下文不被撑大 | `plugin:<name>` |
| MCP 工具 | `runtime.connectMcp(config, { source })`，工具名 `<server名>__<工具>` | `plugin:<name>` |
| 命令 | 不进内核。`PluginManager.commands()` 列出 `/<插件>:<命令>`，`expandCommand()` 展开成要发的话，由外壳发 | — |
| 代码钩子 | `runtime.hooks.register(source, hooks, { priority })` | `plugin:<name>` |
| 常驻进程 | 同 MCP，但插件包再挂一个 `beforeRequest` 把它的工具从工具表里拿掉、`beforeTool` 拒绝调用 | `plugin:<name>` |
| 不可逆声明 | 插件包挂一个 `beforeTool`（优先级 10），对声明过的工具返回 `confirm`（本插件任何 server 的工具，mcp/ 和 services/ 都算；模型调隐藏的服务工具先返回 `deny`） | `plugin:<name>` |
| 视图 | 不进内核。`views()` 列出已启用插件的页面，外壳渲染；页面调工具走 `viewCall()` → 内核 `callPluginTool`（钩子生效、留痕） | — |

server 名：插件只有一个 `mcp/` server 时就叫插件名（工具 `notes__write_note`），有多个时叫 `<插件>-<id>`；常驻进程一律 `<插件>-<id>`。

## 4. 生命周期

```
 装入 install(文件夹 | zip)
   读清单 + 各部件 → 校验（人话问题列表）→ 版本兼容检查
   → 复制到 <插件根>/installed/<name>/<version>/ → state.json 记 current / previous
 启用 enable(name)                      停用 disable(name)：反序撤
   1 技能（inject 钩子 + __skill 工具）        5 停常驻进程
   2 权限钩子（不可逆确认、隐藏服务工具）      4 解绑代码钩子
   3 启动 mcp/ 里的 server，工具进工具表       3 断开 MCP server（工具消失、进程停）
   4 加载并注册代码钩子                       2,1 撤权限钩子、技能
   5 启动 services/ 里的常驻进程              最后 runtime.unregisterSource('plugin:<name>') 兜底
```

- 任何一步失败：已经做的步骤按反序撤掉，插件保持停用，发 `plugin.error`（例：「「笔记」启用失败：钩子 hooks/bad.js 加载失败：…」）。不会出现「一半启用」。
- 生命周期操作串行执行（启用、停用、安装、切模拟模式不会交错）。
- 已启用的插件升级：先停旧版 → 换版本 → 启新版；新版起不来自动退回旧版并提示。
- 同一版本再装一次（改了代码没改版本号，开发时常见）：先把新文件复制到旁边（`<版本>~new-…`）→ 停插件 → 把旧文件夹改名挪开当备份（`~old-…`）→ 把新文件夹改名换进来 → 启用。Windows 上文件夹里有文件开着（插件的进程、杀毒软件在读刚复制的文件）时改名会整体失败、什么都不动，所以每一步遇到占用就重试，最多等 10 秒；哪一步都不行，就把旧文件放回原处、照原样启用，提示「安装文件夹仍被占用」。新文件起不来时，先把新文件挪开（`~bad-…`）再放回旧文件；连旧文件也放不回去时如实提示、插件停用。卸载也是先改名挪开（`~removing-…`）再删，挪不开就照原样启用、不改记录。被打断留下的这些 `~` 文件夹，下次启动时清掉（`~` 不会出现在插件名和版本号里）；只有一种例外：它是仅剩的一份时改回原名而不删，即正式的版本文件夹不在而旁边有 `~old-…`（换文件换到一半），或者记录还在而插件文件夹被挪成了 `~removing-…`（卸载做到一半，卸载先改记录再删文件夹）。
- `load()`：应用启动时读 `state.json`，把上次启用的插件重新启用，失败的列出来、保持停用。`shutdown()`：关应用时全部停掉但不改「启用」标记。
- 插件根默认由外壳决定（建议 `%APPDATA%\Spica\plugins`，用户目录，不需要管理员权限）：
  - `installed/<name>/<version>/` 每个版本一份，保留当前和上一版；
  - `data/<name>/` 插件可写的数据，升级、回滚都保留；
  - `logs/<name>.log` 生命周期、server 的 stderr、钩子错误；
  - `state.json` 启用状态、当前 / 上一版、来源、模拟模式。

钩子模块用 `import(文件URL?v=版本-序号)` 加载：ESM 模块没法从内存里卸掉，但撤销靠的是解绑注册，不靠卸载；带序号保证升级后拿到的是新代码。

## 5. 外部进程（MCP server）

- 统一是 stdio 的 MCP server，由内核的 MCP 客户端启动和通话（`spawn` 带 `windowsHide: true`，不用 `shell`）。插件包只负责拼启动参数、管重启和日志。
- 环境变量（宿主填）：`SPICA_PLUGIN_NAME`、`SPICA_PLUGIN_VERSION`、`SPICA_PLUGIN_DIR`（安装目录，只读）、`SPICA_PLUGIN_DATA`（可写）、`SPICA_MOCK`（`1` / `0`）；Node 类再加 `ELECTRON_RUN_AS_NODE=1`。工作目录是插件安装目录。
- **Node 类：用 Electron 自带的 Node。** 启动命令是 `process.execPath`（Electron 主程序）+ `ELECTRON_RUN_AS_NODE=1`。理由：用户什么都不用装；和桌面端是同一个 Node 版本（Electron 45 = Node 24.22），作者在本机用 Node 24 开发即可；不另带一个 node.exe，安装包不变大。纯 Node 下（测试、冒烟脚本）这个变量无害，所以测试和真机走同一条路。依赖打进包里（MCPB 的做法），不在用户电脑上 `npm install`。
- **Python 类，这一版：插件自带独立可执行文件**（PyInstaller / Nuitka 打成 `.exe`），清单写 `"runtime": "binary"`，宿主只负责启动。
- **Python 类，以后：宿主托管解释器（只写方案，不写代码）。**
  - 做法：清单写 `"runtime": "python"`、`"python": ">=3.11"`、`"requirements": "requirements.lock"`。宿主第一次需要时从可配置的镜像（默认 python-build-standalone 的发布页，公司可指到内网）下载便携版 CPython 到 `%LOCALAPPDATA%\Spica\python\<版本>`，每个插件一个 venv（`<插件根>/envs/<name>/`），用随应用带的 `uv.exe` 按锁文件安装依赖，再用 `pythonw.exe` 启动（不弹控制台）。
  - 为什么不现在做：要随应用带 `uv.exe`、管下载和镜像、处理公司网络「能下不能传」的代理；首版 J6 用 Node 就能验，自带 exe 已覆盖「接没有 API 的系统」这类插件。
  - 为什么选 uv 而不是 pip + 自己管：uv 是单个可执行文件、不需要先有 Python、支持锁文件和离线缓存，装依赖快；许可证 MIT / Apache-2.0。
- **崩溃重启**：进程意外退出（内核 `onExit` 的 `expected=false`）→ 先撤掉它的工具 → 退避（250 ms、500 ms、1 s…）后重启；同一个时间窗（默认 60 秒）里超过上限（默认 3 次，清单可改，0–10）就停止重启，状态 `failed`，发 `plugin.error`：「「笔记」进程 notes 在 60 秒内崩溃了 4 次，已停止重启。详情见插件日志。」重新启用即可再试。
- **日志**：server 的 stderr 逐段写进 `logs/<name>.log`，不显示在界面上；`describe()` 的 `lastError` 给界面一句话。
- **打包**：`packPlugin(文件夹, 输出目录)` 产出 `<name>-<version>.zip`（固定时间戳，同样的文件得到同样的校验和），附 SHA-256。`verifyPackage(zip, 校验和?)` 解到临时目录校验；`unpackPlugin` 拒绝 `..`、绝对路径、盘符的条目，也接受 Windows「发送到 → 压缩文件夹」那种外面多套一层目录的 zip。zip 读写只用 `node:zlib`，不加依赖。插件根目录可放 `.spicaignore`（同 MCPB 的 `.mcpbignore`，取 .gitignore 的常用子集：`*`、`**`、`?`，末尾 `/` 只配文件夹，带 `/` 的从插件根算，不支持 `!`），列出不进包的开发文件（测试、脚本等）；`manifest.json` 永远进包。打完先在临时目录装一遍，装不上就不写出，免得忽略规则把要用的文件排除掉。

## 6. 模拟模式

- 一个全局开关：`PluginManager.setMock(on)`，存进 `state.json`，发 `mock.changed`；外壳在插件页和状态栏显示（「模拟数据」标记），这一处归桌面外壳。
- 落地方式：server 启动时的环境变量 `SPICA_MOCK=1`。切开关会把已启用插件的 server 全部重启，保证工具结果和开关一致；钩子通过 `ctx.mock()` 实时读。
- 插件自己决定模拟时返回什么（约定放 `mock/` 目录）；清单 `mock.supported` 只用来在界面上标「支持模拟」。模拟结果第一行写明 `[sample data — mock mode]`，模型和用户都不会把它当成真数据。
- 示例：`search_catalog` 在开关关着、又没配真服务时，返回「服务没配置，打开模拟模式可用样例数据」；开着时返回 `mock/catalog.json` 里的虚构书目。

## 7. 安全边界

| 边界 | 现在怎么做 | 以后 |
|---|---|---|
| 文件路径 | 清单里所有路径必须在插件文件夹内；zip 解包拒绝越界条目；插件自己的数据只写 `SPICA_PLUGIN_DATA`；用户在对话里点名的文件夹也可以写（下载、导出类插件的本职）：只写那个文件夹和它下面，结果里原样回显路径，覆盖已有文件的工具标成不可逆（作者指南 2b 节）。这一条是约定，不拦 | 见「工作文件夹」一行 |
| 钩子权限 | 只挂 `permissions.hooks` 声明过的类型；没声明的写日志、不挂 | 安装时给用户看「这个插件能改请求 / 改响应 / 拦工具」 |
| 钩子出错 | 包一层：抛错只记日志、发 `hook.error`，这一轮照常跑 | 连续出错自动停用 |
| 不可逆动作 | `permissions.irreversible` 里的工具一律要确认（mcp/ 和 services/ 的工具一样，不论是模型调还是页面调）；MCP 的 `destructiveHint` 内核也默认要确认 | 插件可在设置里被用户改成「自动执行」 |
| 工作文件夹 | `permissions.workspace` 只声明、展示 | 插件包挂 `beforeTool`：参数里出现的路径不在会话工作文件夹内、也不是用户在对话里点名的文件夹，就拒绝（怎么认出「用户点名」到时再定）；`read` 的插件写项目文件夹也拒绝 |
| 网络 | 插件 server 和应用用同一套网络设置：内核起子进程时注入代理（`HTTPS_PROXY` 等 + `NODE_USE_ENV_PROXY=1`）和信任名单（`NODE_EXTRA_CA_CERTS` + `NODE_USE_SYSTEM_CA`；自带可执行文件用 `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` 的全量证书），设置里没有的就从子进程环境里删掉（内核 f8d328d）。设置真变了时内核调扩展的 `networkChanged()`，插件这边重启在运行的 server（`restartServers()`），之后的请求用新设置；有认证的代理，账号密码会随代理地址进插件进程。`permissions.network` 只声明、展示 | 按 `permissions.network` 放行 |
| 环境变量 | 插件进程只继承白名单（`PLUGIN_INHERIT_ENV`：PATH、系统目录、TEMP、用户目录、电脑名和用户名（`COMPUTERNAME`、`USERNAME`）、代理变量等；和内核的 `DEFAULT_CHILD_ENV`、作者工具包 `lib/mcp.mjs` 里的同一张表，有测试保证三处一致），像密钥的名字（SPICA_ 开头、含 KEY / SECRET / TOKEN / PASSWORD / CREDENTIAL）内核一律不传；有测试 | — |
| 插件页面 | 沙箱里跑，没有 Node；只能取本插件目录里的文件；只能调本插件、本视图 `permissions.tools` 里的工具；`permissions.irreversible` 里的工具先由外壳弹确认框：清单里的声明和 MCP 的 `destructiveHint` 都会要确认，mcp/ 和 services/ 的工具一样 | 页面调用记进插件日志 |
| 来源可信 | HTTP 来源每个包必须有 SHA-256，不对拒装；共享盘有索引就校验 | 包签名 |

## 8. 分发与更新

- 两种来源，同一种索引文件 `index.json`：

  ```json
  { "index_version": 1, "plugins": [
    { "name": "notes", "version": "0.2.0", "file": "notes-0.2.0.zip", "sha256": "…", "spica": ">=0.1.0", "description": "…" }
  ] }
  ```

  - **共享盘**：`{ kind: 'share', location: '\\\\server\\plugins' }`。有 `index.json` 就按它；没有就扫：带 `manifest.json` 的子文件夹、`*.zip` 都算。`file` 以 `/` 结尾表示文件夹。
  - **HTTP**：`{ kind: 'http', location: 'https://…/index.json' }`。`file` 相对索引地址解析；必须有 `sha256`。桌面端传 Electron 的 `net.fetch`，走系统代理。
  - 发布者用 `writeIndex(文件夹)` 给一堆 zip 生成索引。
- 版本比较按 semver（预发布版低于正式版）；同一插件多个版本取兼容范围内最新的。
- `checkUpdates(manager, 来源列表)` → 可更新列表；读不了的来源单独列出（「找不到共享文件夹 …，检查盘有没有连上」），不影响别的来源。
- `installAvailable(manager, 条目)`：下载 → 校验和 → 解包到临时目录 → `install()`。已启用的插件更新后继续启用，数据保留。
- `rollback(name)`：切回上一版（上一版和当前版互换，可以再切回来）。

## 9. 给桌面外壳的接口

外壳的插件页用这些（都在 `@spica/plugins` 导出）：

| 接口 | 用途 |
|---|---|
| `new PluginManager({ host: runtimeHost(runtime), root })`、`load()`、`shutdown()` | 主进程启动 / 关闭时 |
| `list()`、`describe(name)` → `PluginDescription` | 列表与详情：版本、上一版、来源、权限、技能、命令、当前工具、钩子、进程状态、视图、问题 |
| `check(文件夹)`、`install(文件夹, 来源, { onProgress })`、`installZip(manager, 字节, 来源, { onProgress })` | 「从文件夹 / zip 安装」；`onProgress` 收到每一步（`InstallStep`：download 带已收字节和总数 / read / verify / unpack / copy / stop / replace，文件夹被占用重试时带 `busyMs` / start） |
| `enable`、`disable`、`uninstall`、`rollback` | 开关、删除、退回上一版 |
| `setMock(on)`、`mock` | 模拟模式开关 |
| `listSource`、`checkUpdates`、`installAvailable(manager, 条目, { onProgress })`、`downloadPackage(网址, { onProgress })` | 来源、更新提示、一键更新；下载只在 60 秒收不到数据时才算失败（`DOWNLOAD_IDLE_MS`，慢不算），边下边报字节 |
| `commands()`、`expandCommand(name, args)` | 输入框里的 `/` 命令 |
| `views()` → `PluginView[]`、`resolveViewFile(插件, 相对路径)`、`viewCall(插件, 视图, 工具, 参数, { confirmed })` | 插件页面：列表、取文件、调工具（见第 2 节「视图」） |
| `describe(name).model`、`modelUsage()`、`setModelLimit(name, 美元 | null)` | 用模型的插件：理由、生效的上限、清单上限、用户上限、今天花了多少（`spentTodayUsd`，来自内核 `runtime.sampler.spentToday`）；用户自己的上限（`null` = 回到清单值，`0` = 不让用） |
| `restartServers()` | 网络设置变了：重启在运行的插件 server（后端扩展的 `networkChanged()` 调它） |
| `on(listener)` → `PluginEvent` | `plugin.installed / uninstalled / enabled / disabled / error`、`server.status`、`hook.error`、`mock.changed` |

所有面向用户的报错都是中文人话（`PluginError.message`，带 `issues` 明细）。

**在后端进程里**：插件包是内核后端的一个扩展（`BackendConfig.extensions: [{ module: '@spica/plugins', options: { root } }]`），内核在 `restore()` 之后调 `attachBackend(runtime, options)`：建 `PluginManager`、`load()`，交回
- 本程序 MCP 服务上的工具：`spica_plugins_list`、`spica_plugin_describe`、`spica_plugin_install {path, enable?}`（文件夹或 zip）、`spica_plugin_enable` / `disable` / `uninstall` / `rollback {name}`、`spica_plugins_set_mock {on}`；当前工具表用内核的 `spica_list_tools`。
- 后端端口上的方法（外壳插件页走同一个进程）：`pluginsList`、`pluginDescribe`、`pluginCheck`、`pluginInstall`、`pluginEnable`、`pluginDisable`、`pluginUninstall`、`pluginRollback`、`pluginsMock`、`pluginsSetMock`、`pluginCommands`、`pluginExpandCommand`；插件页面用 `pluginViews()`、`pluginViewFile({ plugin, path })` → 绝对路径或 `null`、`pluginViewCall({ plugin, view, tool, args, confirmed? })`；用模型的插件用 `pluginModelUsage()` → `[{ plugin, displayName, enabled, reason, maxUsdPerDay, declaredMaxUsdPerDay, userMaxUsdPerDay?, spentTodayUsd? }]`、`pluginSetModelLimit({ plugin, maxUsdPerDay })`（`null` 回到清单值）→ 新的 `PluginDescription`。
- 关闭时先停插件进程，再关内核。

J6 经 MCP 服务自动跑：`npm run journey:j6 -w @spica/plugins`（真模型，读 .env.local）：装上 → 工具出现 → Agent 调 `notes__write_note` / `notes__read_note` → 停用 → 工具消失、Agent 也调不到。

## 10. 验收记录

| 日期 | 测试 | 冒烟 |
|---|---|---|
| 2026-11-09 | 3 个测试文件 31 条全过（另加：重启 server 不误撤同插件的技能工具、插件进程拿不到白名单外的环境变量）：清单校验与人话提示、路径越界与控制台脚本拒绝、J6 全撤销（工具、钩子、注入、进程）、describe、不可逆确认、模拟模式切换、重启后恢复、钩子加载失败整体回滚、未声明钩子不挂、钩子抛错不影响运行、崩溃重启上限、server 起不来、清单错误和版本不兼容拒装、zip 往返与越界、打包可复现与校验、Windows 压缩文件夹、共享盘扫描、来源不可达、共享盘更新与回滚（数据保留）、HTTP 索引 + 校验和（篡改拒装、无校验和拒装）、坏新版自动退回、装用户选的 zip | `npm run smoke:plugins -w @spica/plugins`：装上 → 工具立刻出现（server 启动约 0.2 秒）→ 调用 → 模拟模式开关 → 停用 → 工具消失，13 项全过；`smoke:plugins:model`：DeepSeek flash 自己调 `notes__read_note` 并正确复述笔记。示例 server 用 Electron 45 自带 Node（`ELECTRON_RUN_AS_NODE=1`）直接跑通握手和工具列表 |

## 11. 故意没做的

- 插件设置表单（MCPB 的 `user_config`）、包签名、工作文件夹 / 网络的强制拦截、宿主托管 Python：见上文「以后」。
- 外壳的插件页、模拟模式标记、来源设置：归桌面外壳，本包只给接口和事件。
- 官方 Outlook 插件：另开话题。

## 12. 交接（2026-11-09）

- **做了什么**：`@spica/plugins`（清单、文件夹、启用 / 停用全撤、失败回滚、崩溃重启上限、模拟模式、describe()、zip 打包与校验、共享盘 / HTTP 来源、更新与回滚、环境变量白名单）；示例插件 `plugins/example-notes`；J6 冒烟 `npm run smoke:plugins -w @spica/plugins`（13 项）和真模型版 `smoke:plugins:model`；本文和作者指南。提交 b0e3fe6、6080a52 和本次。
- **内核配合**（已提交 2e0bb76）：`connectMcp(config, { source })`、`onExit`、`stderrLog`、可等待的 `disconnect()`、单个 server 只撤自己的工具、`inheritEnv` 白名单。
- **故意没做**：插件页界面与模拟数据标记（归桌面外壳，接口见第 9 节）；工作文件夹 / 网络权限的强制拦截；插件设置表单（MCPB 的 user_config）；包签名；宿主托管 Python（方案见第 5 节，何时做待他拍板）。视图的渲染归桌面外壳（接口见第 2 节「视图」）。
- **J6 经 MCP**：`npm run journey:j6 -w @spica/plugins`，7 项全过（DeepSeek flash）。
- **下一步**：外壳经后端端口的 plugin* 方法做插件页，不用自己建 `PluginManager`；插件根建议 `%APPDATA%\Spica\plugins`，写进后端配置的 extensions.options.root。之后官方 Outlook 插件按本格式写。
- **他该看什么**：跑 J6 冒烟看 13 行 ✓；翻 `plugins/example-notes` 看一个插件长什么样。
- **注意**：插件测试要起真进程，机器很忙时默认 5 秒会超时，测试文件里已放宽到 30 秒。
- **2026-11-10 补**：
  - 插件包可用 `.spicaignore` 排除开发文件（6e98464），Outlook 插件已加（b225395）。
  - 插件页面定稿：`views/*.json`、`views()` / `resolveViewFile()` / `viewCall()`、后端端口 `pluginViews` / `pluginViewFile` / `pluginViewCall`，和桌面外壳对好的 `window.spica` 约定见第 2 节「视图」（3865844）；示例插件有 sidebar 的 Notebook 和 panel 的 Quick note（d9428d8）。
  - 给公司端 Claude Code / Codex 用的 skill：`skills/spica-plugin-author`（脚手架、校验打包、安装、页面预览，9db40ef 起）；`packages/plugins/src/skill.test.ts` 用它从零做插件，经 stdio 和 HTTP 装进 Spica 再撤掉。
  - 本机连接：桌面版在 设置 › 常规 › 开发者 打开「允许本机脚本连接 Spica」后写 `<userData>/mcp-http.json`（`{ url, tokenFile, pid, startedAt }`，令牌在 `<userData>/mcp-token`，关掉或退出时删），`install.mjs` 不带连接参数时就读它；没开时用 设置 › 插件 粘 zip 路径装。
  - 应用名：打包时可以换成别的名字（外壳读 deploy.json）。`PluginManagerOptions` / 后端扩展的 options 多了 `appName`（缺省 `Spica`），只换给用户看的中文提示；`readPluginFolder` / `parseManifest` / `unpackPlugin` / `verifyPackage` / `packPlugin` 也接 `{ appName }`（文字规范之后，「当前版本不支持…」这类提示不再带应用名，`runtimeHost` 也就不接了）。包名、`window.spica`、`spica_` 工具名、`--spica-*` 变量、`SPICA_` 环境变量、清单的 `compatibility.spica`、`.spicaignore` 都不跟着变。`install.mjs` 加 `--app <名字>`，不带时会在 `%APPDATA%` 下找唯一一个写了 `appName` 且在运行的 `mcp-http.json`。
  - 插件共用应用的网络设置：插件 server 进程拿到和应用一样的代理和信任名单（注入在内核 f8d328d 的 connectMcp 里，插件这边不用改起进程的代码）；改了网络设置后，内核调后端扩展的 `networkChanged()`，manager 的 `restartServers()` 把在运行的 server 重启一遍。我替他定的：改设置后**自动重启插件进程**，不等下次启动（环境变量只在进程启动时读；重启那几秒工具会先撤掉再回来）。`network.test.ts`：用本机自签证书的假内网服务加一个 CONNECT 代理，插件里没有一行证书和代理代码，能连上；取消信任、重启后就被拒。skill：凭据不再「从环境变量读」，改成放 `SPICA_PLUGIN_DATA/config.json`、插件自己的设置页经 `services/` 保存；新增 `references/internal-services.md`；`check.mjs` 看到代码读拿不到的环境变量会提醒。设置页模板这次没进脚手架，先在文档里给写法，等有插件真用到再做。
  - 插件借用用户配好的模型（MCP 取样，内核半边 1aa892e）：清单 `permissions.model { reason, max_usd_per_day }`；manager 起 server 时传 `sampling: { pluginId, maxUsdPerDay }`（清单值和用户值取小，0 或没声明不传）；`describe().model` / `modelUsage()` / `setModelLimit()`，后端端口 `pluginModelUsage` / `pluginSetModelLimit` 给外壳的插件页显示「今天花了多少」和调上限。示例插件加了 `summarize_note`（自己写的 JSON-RPC，不用 SDK），`model.test.ts` 用假模型服务从头走一遍。示例插件的目录服务地址也从环境变量改成数据文件夹里的 `config.json`。skill：`references/model.md`。
  - 文字规范（外壳转、统筹逐句看过的 `out/copy-pass/plugins.md`）：42 句照表改；标「保留」的统一了口气（须为 / 无效 / 未知 / 未安装 / 有错误）；删掉的例子逐句核过，看不出怎么改的补回了例子或去处（description 写在哪、TypeScript 先编译、0 表示禁止使用模型、详见插件日志、views/*.json 的 permissions.tools、检查逗号和引号、author / license / reason / max_usd_per_day 的例子）。`copy.test.ts` 拦禁用词。
  - 修：`permissions.irreversible` 以前只对 mcp/ 的工具生效，services/ 里声明的工具从页面调用时不确认就执行（公司端反馈，统筹复现属实）。权限钩子改为认本插件任何 server 的工具；expose_tools 为 true 的服务工具被模型调用时也要确认；模型调隐藏的服务工具仍先 deny。按 kind 过滤、故意没改的两处：启用时先起 mcp/、钩子之后再起 services/（顺序）；邮件来源只认 mcp/ 的 server。
  - 修：已启用的插件同版本重装时报 EBUSY（Windows 上先删了正被 server 当工作目录的安装文件夹，才去停插件）。现在按上面「同一版本再装一次」的顺序做；卸载也等进程放手再删。Windows 上 Node 写的 server 拉起的普通子进程会随它一起结束，脱离父进程（detached）启动的或自带 .exe 拉起的进程不会，`reinstall.test.ts` 用 detached 子进程覆盖了「稍后退出」和「一直不退」两种。（统筹读码补的三处，同一天：新文件夹换进来那一步也等占用并能退回；卸载改成先改名挪开；同版本起不来时先挪开新文件再放回旧文件。测试里另用替换 `fsOps.rename` 的办法演「杀毒软件占着新复制的文件」。）查过、不用改的：回退和升级到新版本都不删文件夹；installZip、verifyPackage 的临时文件夹不会被进程占用；切模拟模式、网络设置变更、调模型上限只是原地重启进程。
