# 插件系统设计（`@spica/plugins`）

> 状态：首版完成（2026-11-09）。插件文件夹格式、启用 / 停用全撤销、Node 与自带可执行文件两种 MCP server、崩溃重启、模拟模式、打包校验、共享盘 / HTTP 分发与更新、回滚都已做通；示例插件 `plugins/example-notes` 跑通 J6。
> 需求来源：立项书「硬规则」「Harness」「插件」「首版验收 J6」「硬环境约束」。内核侧接口见 `agent-core.md` 第 6 节（钩子）、第 7 节（工具注册、MCP 客户端）。

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
  views/<id>.json           界面视图声明（只定格式，外壳以后渲染）
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
| `license` | 否（警告） | SPDX 写法 |
| `compatibility.spica` | 否（警告） | 兼容范围：`>=0.1.0 <1.0.0`、`^0.1.0`、`~0.1.0`、`*` |
| `permissions.network` | 否 | 插件进程会访问的主机名单；现在只展示给用户，不拦截 |
| `permissions.workspace` | 否 | 对会话工作文件夹（项目文件夹）的访问：`none`（默认）/ `read` / `write`；现在只展示，第 7 节写了以后怎么拦 |
| `permissions.irreversible` | 否 | 不可撤销的工具（写 server 里的原名），调用前一律要用户确认 |
| `permissions.hooks` | 否 | 钩子模块允许挂哪几类：`inject`、`beforeRequest`、`afterResponse`、`beforeTool`、`afterTool`。没声明的一律不挂 |
| `mock` | 否 | `{ "supported": true, "description": "…" }` |

校验从不抛异常，返回问题列表：每条带「哪个文件 · 哪个字段」和一句中文人话（例：`manifest.json · version：版本号「1.0」不合格，应该像 1.2.3 这样三段数字。`）。有 error 就不装、不启用；warning 只展示。

### MCP server / 常驻进程声明 `mcp/<id>.json`、`services/<id>.json`

```json
{
  "runtime": "node",
  "entry": "server/index.js",
  "args": [],
  "env": { "LOG_LEVEL": "info" },
  "timeout_seconds": 30,
  "restart": { "max_restarts": 3, "window_seconds": 60 },
  "expose_tools": true
}
```

- `runtime`：`node`（用宿主的 Node 跑 `.js/.mjs/.cjs`）或 `binary`（插件自带的可执行文件）。写 `python` 会得到提示「这一版只支持自带可执行文件」。
- `entry` 必须是插件文件夹里的相对路径；绝对路径、`..`、盘符一律拒绝。`binary` 不能是 `.cmd/.bat/.ps1/.vbs`（会弹控制台）。
- `env` 不能自己设 `SPICA_` 开头的变量。
- `expose_tools`：`mcp/` 默认 true，`services/` 默认 false。

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
- 钩子类型和参数就是内核的 `Hooks`（`agent-core.md` 第 6 节），六个注入位置照用。
- 只收 ESM `.js/.mjs`；放 `.ts` 会得到「先编译成 .js」的警告。Electron 45 自带的 Node 24.22 其实能跑 TS，但不对插件作者承诺，免得以后换运行时出问题。

### 视图 `views/<id>.json`（只定格式）

```json
{ "title": "Notebook", "placement": "detail", "entry": "views/notebook.html" }
```

`placement`：`sidebar` / `detail` / `settings`。外壳以后用沙箱 iframe 渲染、通过消息桥调插件工具；现在只解析、在 `describe()` 里列出。

## 3. 扩展点总表

| 扩展点 | 进内核的方式 | 来源 |
|---|---|---|
| 技能 | 插件包代注册：一个 `inject` 钩子（`system:after` 放技能目录）+ 一个工具 `<插件>__skill`（按 id 取正文）。模型先看目录，用到时再取全文，上下文不被撑大 | `plugin:<name>` |
| MCP 工具 | `runtime.connectMcp(config, { source })`，工具名 `<server名>__<工具>` | `plugin:<name>` |
| 命令 | 不进内核。`PluginManager.commands()` 列出 `/<插件>:<命令>`，`expandCommand()` 展开成要发的话，由外壳发 | — |
| 代码钩子 | `runtime.hooks.register(source, hooks, { priority })` | `plugin:<name>` |
| 常驻进程 | 同 MCP，但插件包再挂一个 `beforeRequest` 把它的工具从工具表里拿掉、`beforeTool` 拒绝调用 | `plugin:<name>` |
| 不可逆声明 | 插件包挂一个 `beforeTool`（优先级 10），对声明过的工具返回 `confirm` | `plugin:<name>` |
| 视图 | 只进 `describe()` | — |

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
- **打包**：`packPlugin(文件夹, 输出目录)` 产出 `<name>-<version>.zip`（固定时间戳，同样的文件得到同样的校验和），附 SHA-256。`verifyPackage(zip, 校验和?)` 解到临时目录校验；`unpackPlugin` 拒绝 `..`、绝对路径、盘符的条目，也接受 Windows「发送到 → 压缩文件夹」那种外面多套一层目录的 zip。zip 读写只用 `node:zlib`，不加依赖。

## 6. 模拟模式

- 一个全局开关：`PluginManager.setMock(on)`，存进 `state.json`，发 `mock.changed`；外壳在插件页和状态栏显示（「模拟数据」标记），这一处归桌面外壳。
- 落地方式：server 启动时的环境变量 `SPICA_MOCK=1`。切开关会把已启用插件的 server 全部重启，保证工具结果和开关一致；钩子通过 `ctx.mock()` 实时读。
- 插件自己决定模拟时返回什么（约定放 `mock/` 目录）；清单 `mock.supported` 只用来在界面上标「支持模拟」。模拟结果第一行写明 `[sample data — mock mode]`，模型和用户都不会把它当成真数据。
- 示例：`search_catalog` 在开关关着、又没配真服务时，返回「服务没配置，打开模拟模式可用样例数据」；开着时返回 `mock/catalog.json` 里的虚构书目。

## 7. 安全边界

| 边界 | 现在怎么做 | 以后 |
|---|---|---|
| 文件路径 | 清单里所有路径必须在插件文件夹内；zip 解包拒绝越界条目；插件可写的只有 `SPICA_PLUGIN_DATA` | — |
| 钩子权限 | 只挂 `permissions.hooks` 声明过的类型；没声明的写日志、不挂 | 安装时给用户看「这个插件能改请求 / 改响应 / 拦工具」 |
| 钩子出错 | 包一层：抛错只记日志、发 `hook.error`，这一轮照常跑 | 连续出错自动停用 |
| 不可逆动作 | `permissions.irreversible` 里的工具一律要确认；MCP 的 `destructiveHint` 内核也默认要确认 | 插件可在设置里被用户改成「自动执行」 |
| 工作文件夹 | `permissions.workspace` 只声明、展示 | 插件包挂 `beforeTool`：参数里出现的路径不在会话工作文件夹内就拒绝，`read` 的插件写文件也拒绝 |
| 网络 | `permissions.network` 只声明、展示 | 视需要给 server 注入代理并按名单放行 |
| 环境变量 | 插件进程只继承白名单（`PLUGIN_INHERIT_ENV`：PATH、系统目录、TEMP、用户目录、代理变量等），像密钥的名字（SPICA_ 开头、含 KEY / SECRET / TOKEN / PASSWORD / CREDENTIAL）内核一律不传；有测试 | — |
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
| `check(文件夹)`、`install(文件夹, 来源)`、`installZip(manager, 字节, 来源)` | 「从文件夹 / zip 安装」 |
| `enable`、`disable`、`uninstall`、`rollback` | 开关、删除、退回上一版 |
| `setMock(on)`、`mock` | 模拟模式开关 |
| `listSource`、`checkUpdates`、`installAvailable` | 来源、更新提示、一键更新 |
| `commands()`、`expandCommand(name, args)` | 输入框里的 `/` 命令 |
| `on(listener)` → `PluginEvent` | `plugin.installed / uninstalled / enabled / disabled / error`、`server.status`、`hook.error`、`mock.changed` |

所有面向用户的报错都是中文人话（`PluginError.message`，带 `issues` 明细）。

## 10. 验收记录

| 日期 | 测试 | 冒烟 |
|---|---|---|
| 2026-11-09 | 3 个测试文件 31 条全过（另加：重启 server 不误撤同插件的技能工具、插件进程拿不到白名单外的环境变量）：清单校验与人话提示、路径越界与控制台脚本拒绝、J6 全撤销（工具、钩子、注入、进程）、describe、不可逆确认、模拟模式切换、重启后恢复、钩子加载失败整体回滚、未声明钩子不挂、钩子抛错不影响运行、崩溃重启上限、server 起不来、清单错误和版本不兼容拒装、zip 往返与越界、打包可复现与校验、Windows 压缩文件夹、共享盘扫描、来源不可达、共享盘更新与回滚（数据保留）、HTTP 索引 + 校验和（篡改拒装、无校验和拒装）、坏新版自动退回、装用户选的 zip | `npm run smoke:plugins -w @spica/plugins`：装上 → 工具立刻出现（server 启动约 0.2 秒）→ 调用 → 模拟模式开关 → 停用 → 工具消失，13 项全过；`smoke:plugins:model`：DeepSeek flash 自己调 `notes__read_note` 并正确复述笔记。示例 server 用 Electron 45 自带 Node（`ELECTRON_RUN_AS_NODE=1`）直接跑通握手和工具列表 |

## 11. 故意没做的

- 视图渲染、插件设置表单（MCPB 的 `user_config`）、包签名、工作文件夹 / 网络的强制拦截、宿主托管 Python：见上文「以后」。
- 外壳的插件页、模拟模式标记、来源设置：归桌面外壳，本包只给接口和事件。
- 官方 Outlook 插件：另开话题。

## 12. 交接（2026-11-09）

- **做了什么**：`@spica/plugins`（清单、文件夹、启用 / 停用全撤、失败回滚、崩溃重启上限、模拟模式、describe()、zip 打包与校验、共享盘 / HTTP 来源、更新与回滚、环境变量白名单）；示例插件 `plugins/example-notes`；J6 冒烟 `npm run smoke:plugins -w @spica/plugins`（13 项）和真模型版 `smoke:plugins:model`；本文和作者指南。提交 2caf365、6064913 和本次。
- **内核配合**（已提交 e473a9d）：`connectMcp(config, { source })`、`onExit`、`stderrLog`、可等待的 `disconnect()`、单个 server 只撤自己的工具、`inheritEnv` 白名单。
- **故意没做**：插件页界面与模拟数据标记（归桌面外壳，接口见第 9 节）；工作文件夹 / 网络权限的强制拦截；插件设置表单（MCPB 的 user_config）；包签名；宿主托管 Python（方案见第 5 节，何时做待他拍板）；视图渲染。
- **下一步**：外壳在主进程建 `PluginManager`（插件根 `%APPDATA%Spicaplugins`，传 Electron 的 `net.fetch` 给来源）并做插件页；之后官方 Outlook 插件按本格式写。
- **他该看什么**：跑 J6 冒烟看 13 行 ✓；翻 `plugins/example-notes` 看一个插件长什么样。
- **注意**：插件测试要起真进程，机器很忙时默认 5 秒会超时，测试文件里已放宽到 30 秒。
