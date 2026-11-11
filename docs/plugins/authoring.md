# 从零写一个 Spica 插件

> 给插件作者看。读完能写出一个带工具、技能、命令、钩子和模拟数据的插件，打包后放到共享盘或网站上分发。完整的可运行例子在 `plugins/example-notes`。格式的来龙去脉见 `docs/design/plugins.md`。
>
> 让 Claude Code / Codex 代写：把 `skills/spica-plugin-author` 复制到 `~/.claude/skills/` 或 `~/.codex/skills/`，它会按本指南生成骨架、校验打包、装进 Spica 并试用。

## 0. 你需要什么

- Node 24（和 Spica 桌面端自带的 Node 同一大版本）。用户那边什么都不用装：你的 server 会用 Spica 自带的 Node 跑。
- 一个文件夹。下面以做一个「待办」插件为例，名字叫 `todo`。

## 1. 写清单

`todo/manifest.json`：

```json
{
  "manifest_version": 1,
  "name": "todo",
  "version": "0.1.0",
  "display_name": "To-do list",
  "description": "Keep a simple to-do list.",
  "author": { "name": "Your Name" },
  "license": "Apache-2.0",
  "compatibility": { "spica": ">=0.1.0" },
  "permissions": {
    "workspace": "none",
    "irreversible": ["clear_all"],
    "hooks": ["inject"]
  },
  "mock": { "supported": false }
}
```

要点：

- `name` 只能用小写字母、数字和 `-`，2–24 个字符。它会成为工具名的前缀（`todo__add`），定了以后别改。
- `version` 用三段数字。每次发新版都要加，Spica 靠它判断有没有更新。
- 会删数据、发东西、写外部系统的工具，写进 `permissions.irreversible`，Spica 每次调用前都会先问用户。mcp/ 和 services/ 里的工具都适用。
- 用到哪几类钩子，写进 `permissions.hooks`；没写的钩子不会生效。

### 插件图标（可选）

设置 › 插件 的列表和详情里，插件名前面有一个图标。清单里不写 `icon` 时，Spica 用名字的第一个字放在一个色块上代替；要用自己的图标，在清单里加一行，图标放在插件文件夹里：

```json
"icon": "icon.svg"
```

- 只收 `.svg`，写插件文件夹里的相对路径（不能用 `..`、绝对路径），文件要存在，不能大于 64 KB。和页面的 `icon` 是同一套路径规矩。
- 按 24×24 画，显示时缩成 22 像素见方的圆角方块，所以四周不用留白，形状画满。
- 图标只当图片显示：里面的脚本、事件属性（`onload` 之类）、外部链接都不会生效，`check.mjs` 看到会提醒删掉。
- 颜色写死在图标里，不跟随 Spica 的明暗（`currentColor` 在这里是黑色）。深色和浅色两种皮肤上都要看得清，最稳的是带底色的方块。页面的 `icon`（`views/*.json`）不同，它画在侧栏里，跟随主题用 `currentColor`。
- 写错了（路径、类型、大小）插件装不上，提示里写清是哪一条。
- 例子：`plugins/example-notes/icon.svg`；脚手架 `scaffold.mjs` 生成的插件自带一个，换成自己的就行。

## 2. 写 MCP server（工具）

声明 `todo/mcp/todo.json`：

```json
{ "runtime": "node", "entry": "server/index.js" }
```

server 就是一个读 stdin、写 stdout 的程序，一行一条 JSON-RPC 消息（MCP 的 stdio 传输）。最少要答三种请求：`initialize`、`tools/list`、`tools/call`。可以直接用官方 MCP SDK（把 `node_modules` 一起打进包里），也可以像示例那样不用依赖、自己写几十行——见 `plugins/example-notes/server/index.js`。

Spica 启动 server 时会给这些环境变量：

| 变量 | 用途 |
|---|---|
| `SPICA_PLUGIN_DATA` | 插件自己的数据文件夹，升级、回滚都保留；除了它，只能写用户在对话里点名的文件夹（见 2b 节） |
| `SPICA_PLUGIN_DIR` | 插件安装目录（只读） |
| `SPICA_MOCK` | `1` 表示用户开了模拟模式 |
| `SPICA_PLUGIN_NAME`、`SPICA_PLUGIN_VERSION` | 名字和版本 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`、`NODE_USE_ENV_PROXY` | 应用的代理设置（设置 › 常规 › 网络），没设代理时不给 |
| `NODE_EXTRA_CA_CERTS`、`NODE_USE_SYSTEM_CA`、`SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE` | 应用信任的证书（系统证书和「信任的证书文件」），Node 的 `fetch` / `https` 直接就用上了（这一行和上一行从 0.1.0-rc.2 起才有） |

其他环境变量只继承白名单：PATH、TEMP、用户目录、代理变量这类，外加 `COMPUTERNAME`（电脑名）和 `USERNAME`（用户名）；名字带 KEY、TOKEN、SECRET 的一律不传。取电脑名也可以用 Node 的 `os.hostname()`，不依赖环境变量。所以服务地址和凭据不要从环境变量读，放 `SPICA_PLUGIN_DATA` 里的配置文件，由插件自己的设置页经 `services/` 里的工具保存；证书和代理不要自己处理。用户改了网络设置，正在运行的插件 server 会自动重启一次。写法见 `skills/spica-plugin-author/references/internal-services.md`。

几条规矩：

- 往 stdout 只写协议消息；日志写 stderr，Spica 会存进插件日志。
- 工具出错时返回 `isError: true` 的结果，写一句模型和人都看得懂的话，不要直接崩溃。
- 进程崩溃 Spica 会自动重启，但 60 秒内超过 3 次就停（可在声明里用 `restart` 改）。
- Python 写的 server：这一版请用 PyInstaller 之类打成 `.exe`，声明写 `"runtime": "binary"`、`"entry": "bin/server.exe"`。别用 `.bat` / `.cmd` 启动，会弹黑窗口，Spica 会拒绝。

## 2b. 把文件写到用户点名的文件夹

插件自己的数据放 `SPICA_PLUGIN_DATA`。下载、导出一类插件的本职是把文件放到用户指定的地方：**用户在对话里明确给出的文件夹可以写**，按下面几条做：

- 文件夹由工具参数传进来（例如 `dest_folder`，写进 `required`），参数说明写明「用户在对话里给出的文件夹，不要自己猜」。没给就返回错误请用户说一个，不要退回到某个默认的外部文件夹。
- 只写这个文件夹和它下面：先解析成绝对路径，文件名里带 `..`、盘符或绝对路径的一律拒绝，不往上一级、别的盘或别的文件夹写。文件夹不存在就按用户给的路径建出来，不换地方。
- 结果里原样写出实际写到的完整路径和文件名，让用户看得到东西放在哪。
- 默认不覆盖：同名文件已经存在就跳过，并在结果里列出来。要覆盖已有文件，做成一个单独的工具（例如 `download_replace`），写进 `permissions.irreversible`，Spica 每次调用前都会先问用户。
- `permissions.workspace` 只管会话的项目文件夹；写用户点名的文件夹不用为此声明 `write`。这几条现在是约定，Spica 不拦，`check.mjs` 也不查。

## 2c. 要跑很久的工具（批量下载、导出一类）

Spica 调工具时等的是「有没有动静」：`mcp/<id>.json` 的 `timeout_seconds`（缺省 60）秒里既没有结果、也没有进度，这次调用就算失败。工具一直在报进度，就一直等，最长等 `max_call_seconds`（缺省 3600，也就是 60 分钟），到了照样停。需要 Spica 0.1.0-rc.2 之后发布的版本，更早的版本不管进度，`timeout_seconds` 一到就停。

```json
{ "runtime": "node", "entry": "server/index.js", "timeout_seconds": 60, "max_call_seconds": 7200 }
```

报进度用 MCP 的进度通知（progress）。Spica 调工具时会在请求里带 `params._meta.progressToken`，工具干活时隔一阵发一条（不用 SDK 的写法，`send` 同示例插件）：

```js
const token = msg.params._meta?.progressToken;
// 每做完一批发一次；progress 必须越来越大，total、message 可以不写
send({ method: 'notifications/progress', params: { progressToken: token, progress: done, total: all, message: `${done}/${all} 个文件` } });
```

- 隔 10 到 30 秒报一次就够，别每个文件都报。没有 `progressToken` 就不报（旧版 Spica 不带，照旧按 `timeout_seconds` 算）。
- 超时或用户点了停止，Spica 会发 `notifications/cancelled`（`params.requestId` 是这次调用的 id）。收到就停手、释放资源，不用再回结果，回了也没人收。已经写好的文件留着，下次调用时跳过已有的，从没做完的地方接着做。
- 用官方 SDK 时：进度用工具处理函数第二个参数里的 `extra._meta?.progressToken` 和 `extra.sendNotification(...)`，取消看 `extra.signal`。
- `max_call_seconds` 防的是插件卡死或写坏了一直报进度；要做几个小时的活，拆成「开始 / 查进度 / 取结果」几个工具更稳，模型可以分几次调。
- 插件页面用 `window.spica.callTool` 调工具时也按同一套规矩等，没有另外的时限。

## 3. 加一个技能

`todo/skills/planning/SKILL.md`：

```markdown
---
name: Planning
description: How to break a goal into to-do items.
---

1. Ask for the deadline if the user did not give one.
2. Split the goal into steps that take under an hour each.
3. Add each step with todo__add, earliest first.
```

模型平时只看到技能的 `description`，用到时才通过 `todo__skill` 取正文，所以 description 要写清楚「什么时候用」。

## 4. 加一个命令

`todo/commands/add.md`：

```markdown
---
description: Add a to-do item
argument-hint: <what to do>
---

Add this to my to-do list: $ARGUMENTS
```

用户在输入框里敲 `/todo:add 买牛奶`，发出去的就是正文，`$ARGUMENTS` 换成「买牛奶」（`$1`、`$2` 是第一、二个词）。

## 5. 加一个钩子

`todo/hooks/hint.js`：

```js
/** @type {import('@spica/plugins/types').HookModule} */
export default (ctx) => ({
  inject() {
    return [{ position: 'system:after', text: 'The to-do plugin is active. Use todo__list before planning.' }];
  },
});
```

- 钩子运行在 Spica 进程里，不需要 import 任何东西，参数就是全部上下文。`ctx` 里有 `dataDir`、`mock()`、`log()`。
- 可用的钩子：`inject`（在系统提示、历史、用户输入前后注入文字）、`beforeRequest`（发请求前改工具表、参数）、`afterResponse`（改模型回答）、`beforeTool`（拦截、改参数、要求确认）、`afterTool`（改工具结果）。参数细节见 `docs/design/agent-core.md` 第 7 节。
- 钩子抛错不会让对话崩掉，只会记进日志。但它这一次就等于没生效。
- 只收 `.js` / `.mjs`。用 TypeScript 写的先编译。

## 5b. 加一个页面（可选）

插件可以带自己的界面，Spica 把它放进侧栏（`sidebar`）或对话旁边的面板（`panel`）。声明 `todo/views/board.json`：

```json
{
  "title": "To-do board",
  "entry": "ui/index.html",
  "placement": "sidebar",
  "icon": "ui/icon.svg",
  "permissions": { "tools": ["list", "add"] }
}
```

页面就是普通的 HTML + JS，用 Spica 注入的 `window.spica` 调你自己的工具：

```js
const r = await window.spica.callTool('list', {});   // 工具原名，不带 todo__ 前缀
if (r.isError) showError(r.content); else render(r.data ?? r.content);
```

| `window.spica` | 作用 |
|---|---|
| `callTool(工具, 参数)` | → `{ content, data?, isError }`；结果是 JSON 时 `data` 是解析好的对象 |
| `onEvent(fn)` | 收 `{ type: 'theme' }`（换了明暗）、`{ type: 'plugin.changed' }`；返回取消函数 |
| `theme` | `{ mode: 'light' \| 'dark' }` |
| `openFile(路径)` | 在 Spica 右栏预览文件（只限本插件目录里的，或这次会话里见过的） |
| `notify(文字, { kind })` | 弹一条提示，`kind` 是 `info` 或 `error` |

- 颜色用 Spica 注入的 CSS 变量：`--spica-bg`、`--spica-surface`、`--spica-fg`、`--spica-muted`、`--spica-border`、`--spica-accent`、`--spica-danger`、`--spica-font`、`--spica-radius`。换明暗时它们会自动变，不用自己判断。
- 沙箱限制：页面里没有 Node，不能 `require`、不能读写文件；只能加载本插件目录里的文件（不能用 CDN，脚本和样式都放进插件）；只能调本插件的工具，写了 `permissions.tools` 就只能调列出的那几个。
- `permissions.irreversible` 里的工具（services/ 里的也算），页面调用时 Spica 会先弹确认框；用户拒绝时 `isError` 为真，`content` 以 `[CONFIRM_REQUIRED]` 开头。
- 页面能调常驻进程（`services/`）的工具：这类工具不给模型、只给自己的页面用，适合做界面专用的接口。
- `sidebar` 是侧栏里一个入口、点开占主区域，适合完整的功能页；`panel` 是对话旁边右栏的一个标签，适合边聊边用的小工具（按 320px 宽设计）。一个插件可以有多个页面。
- 完整例子：`plugins/example-notes` 的 `views/notebook.json`（sidebar）、`views/quick-note.json`（panel），页面在 `ui/`。

## 6. 模拟模式

公司内网的接口在家里连不上时，开发者会打开 Spica 的模拟模式。你的 server 读 `SPICA_MOCK`：

```js
if (process.env.SPICA_MOCK === '1') {
  return { content: [{ type: 'text', text: '[sample data — mock mode]\n' + sample }] };
}
```

- 样例数据放 `mock/` 目录，全部用虚构内容。
- 结果开头写明是样例数据。
- 清单里把 `mock.supported` 设成 `true`，并用 `description` 说一句模拟时会怎样。
- 没开模拟、又连不上真服务时，返回一句「服务连不上，可以打开模拟模式」，别让模型干等。

## 6b. 邮件来源（可选）

插件能列邮件、读邮件时，在清单里加一段，Spica 的邮件流水线就会在插件启用期间定时取新邮件、分到对应项目：

```json
"mail": { "list_tool": "list_messages", "read_tool": "read_message" }
```

- 工具名写 server 里的原名，不带插件前缀。
- 列表结果默认按这些字段读：`messages` 数组，每条有 `id`、`from_name`、`from_address`、`subject`、`received`、`preview`。字段名不一样时用 `fields` 对应，例如 `"fields": { "list": "items", "subject": "title" }`。
- 列表调用默认带 `{ "unread_only": true, "limit": 50 }`，要改就写 `list_args`。
- 例子：`plugins/outlook-mail/manifest.json`。

## 6c. 用 Spica 里配好的模型（可选）

插件要让模型写摘要、分类、改写时，不用自带 key，借用户在 Spica 里配好的模型（MCP 的取样，sampling），需要 Spica 0.1.0-rc.2 之后发布的版本：

```json
"permissions": { "model": { "reason": "给笔记写摘要", "max_usd_per_day": 0.2 } }
```

- `reason` 必填，安装和启用时给用户看；每天的上限缺省 0.5 美元，用户可以在插件页调低（调成 0 就是不让用）。每个插件同时最多 2 个请求、每分钟最多 30 个，用户的总预算也照样管着。
- 用官方 SDK 时调 `server.createMessage({ messages, maxTokens, systemPrompt?, modelPreferences? })`；不用 SDK 的写法见示例插件的 `summarize_note`（`plugins/example-notes/server/index.js`）。只能传文字，不能带工具，看不到用户的对话。
- 先看 `initialize` 里的 `capabilities.sampling`：没有就是没申请、上限是 0，或者 Spica 太旧，给用户一句提示。
- 选模型：什么都不写用默认模型；要强模型把 `intelligencePriority` 设到 0.7 以上，或在 `hints` 里写 `{ name: 'strong' }`；点名用 `hints: [{ name: 'example-large-model' }]`，没配就退回默认模型，结果里带 `_meta.spica.fallback`，`model` 是实际用的那个；必须用点名的模型就加 `_meta: { spica: { requireModel: true } }`，没配就被拒（`model_not_configured`）。
- 被拒绝时是 JSON-RPC 错误 `-32000`，`data.code` 是 `invalid`、`no_model`、`model_not_configured`、`budget`、`rate_limited`、`failed` 之一，要转成一句告诉用户怎么办的话。
- 页面脚本不能直接用，要用就调自己 server 的工具。

## 7. 本地试

在 Spica 仓库里：

```powershell
npm run smoke:plugins -w @spica/plugins   # 示例插件的完整流程，照着改成你的文件夹
```

或在代码里：

```ts
const pm = new PluginManager({ host: runtimeHost(runtime), root: '插件根目录' });
const check = await pm.check('D:/work/todo');   // 只校验，列出全部问题
await pm.install('D:/work/todo');
await pm.enable('todo');
console.log(pm.describe('todo'));
```

清单有问题时，每条提示都会告诉你哪个文件、哪个字段、该怎么改。

## 8. 打包和发布

```ts
import { packPlugin, writeIndex } from '@spica/plugins';
await packPlugin('D:/work/todo', '\\\\server\\spica-plugins');  // 产出 todo-0.1.0.zip
await writeIndex('\\\\server\\spica-plugins');                  // 生成 / 更新 index.json（带 SHA-256）
```

- 包就是一个 zip，`manifest.json` 在最外层；Node 依赖（`node_modules`）一起打进去。
- 测试、开发脚本这类用户用不到的文件，写进插件根目录的 `.spicaignore`，一行一条，写法同 `.gitignore`（不支持 `!`）。例如：

  ```
  test/
  scripts/
  **/*.test.mjs
  ```

  排除后包装不上（比如把 `server/` 排除了），打包会报错，不会写出坏包。别排除 `package.json`：里面的 `"type": "module"` 决定 `.js` 按 ES 模块加载。
- 共享盘：把 zip 放进共享文件夹，最好再生成 `index.json`；用户在 Spica 里把这个文件夹加成来源。
- 网站：把 zip 和 `index.json` 放到同一个目录，用户把 `index.json` 的地址加成来源。网站来源必须有校验和。
- 发新版：改 `version`，重新打包、重新生成索引。用户会看到更新提示；新版起不来会自动退回旧版，用户也可以手动退回上一版。

## 9. 不要做的事

- 不要写数据文件夹（`SPICA_PLUGIN_DATA`）和用户在对话里点名的文件夹以外的地方（后者按 2b 节的规矩写）。插件安装文件夹只读。
- 不要在 `env` 里自己设 `SPICA_` 开头的变量。
- 不要弹控制台窗口，不要要求用户装运行时、要管理员权限。
- 示例、样例数据、文档里不要出现任何真实公司或行业专属的内容。
