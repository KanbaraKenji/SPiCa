# 从零写一个 Spica 插件

> 给插件作者看。读完能写出一个带工具、技能、命令、钩子和模拟数据的插件，打包后放到共享盘或网站上分发。完整的可运行例子在 `plugins/example-notes`。格式的来龙去脉见 `docs/design/plugins.md`。

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
- 会删数据、发东西、写外部系统的工具，写进 `permissions.irreversible`，Spica 每次调用前都会先问用户。
- 用到哪几类钩子，写进 `permissions.hooks`；没写的钩子不会生效。

## 2. 写 MCP server（工具）

声明 `todo/mcp/todo.json`：

```json
{ "runtime": "node", "entry": "server/index.js" }
```

server 就是一个读 stdin、写 stdout 的程序，一行一条 JSON-RPC 消息（MCP 的 stdio 传输）。最少要答三种请求：`initialize`、`tools/list`、`tools/call`。可以直接用官方 MCP SDK（把 `node_modules` 一起打进包里），也可以像示例那样不用依赖、自己写几十行——见 `plugins/example-notes/server/index.js`。

Spica 启动 server 时会给这些环境变量：

| 变量 | 用途 |
|---|---|
| `SPICA_PLUGIN_DATA` | 你唯一可以写的文件夹，升级、回滚都保留 |
| `SPICA_PLUGIN_DIR` | 插件安装目录（只读） |
| `SPICA_MOCK` | `1` 表示用户开了模拟模式 |
| `SPICA_PLUGIN_NAME`、`SPICA_PLUGIN_VERSION` | 名字和版本 |

几条规矩：

- 往 stdout 只写协议消息；日志写 stderr，Spica 会存进插件日志。
- 工具出错时返回 `isError: true` 的结果，写一句模型和人都看得懂的话，不要直接崩溃。
- 进程崩溃 Spica 会自动重启，但 60 秒内超过 3 次就停（可在声明里用 `restart` 改）。
- Python 写的 server：这一版请用 PyInstaller 之类打成 `.exe`，声明写 `"runtime": "binary"`、`"entry": "bin/server.exe"`。别用 `.bat` / `.cmd` 启动，会弹黑窗口，Spica 会拒绝。

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
- 可用的钩子：`inject`（在系统提示、历史、用户输入前后注入文字）、`beforeRequest`（发请求前改工具表、参数）、`afterResponse`（改模型回答）、`beforeTool`（拦截、改参数、要求确认）、`afterTool`（改工具结果）。参数细节见 `docs/design/agent-core.md` 第 6 节。
- 钩子抛错不会让对话崩掉，只会记进日志。但它这一次就等于没生效。
- 只收 `.js` / `.mjs`。用 TypeScript 写的先编译。

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
- 共享盘：把 zip 放进共享文件夹，最好再生成 `index.json`；用户在 Spica 里把这个文件夹加成来源。
- 网站：把 zip 和 `index.json` 放到同一个目录，用户把 `index.json` 的地址加成来源。网站来源必须有校验和。
- 发新版：改 `version`，重新打包、重新生成索引。用户会看到更新提示；新版起不来会自动退回旧版，用户也可以手动退回上一版。

## 9. 不要做的事

- 不要写插件文件夹和数据文件夹以外的地方。
- 不要在 `env` 里自己设 `SPICA_` 开头的变量。
- 不要弹控制台窗口，不要要求用户装运行时、要管理员权限。
- 示例、样例数据、文档里不要出现任何真实公司或行业专属的内容。
