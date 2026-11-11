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
- 只读的工具（只查、只读，不写文件、不发东西、不改任何系统）在工具定义里写 `annotations: { readOnlyHint: true }`。这是 MCP 规范的写法，意思是「这个工具不改动它所处的环境」，不写就当 `false`。没声明的工具，Spica 当成会有改动：一轮回答里调过它，这一轮就不能「重新生成」。
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

Spica 调工具时等的是「有没有动静」：`mcp/<id>.json` 的 `timeout_seconds`（缺省 60）秒里既没有结果、也没有进度，这次调用就算失败。工具一直在报进度，就一直等，最长等 `max_call_seconds`（缺省 3600，也就是 60 分钟），到了照样停。

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

## 2d. 插件拉起的进程

server 常常还要拉起别的进程。分两类，规矩不一样：**辅助进程**（打包进插件、替 server 干活的程序）要跟着插件一起结束；**替用户打开的程序**（之后用户自己还要用的桌面程序）要和插件完全分开，插件怎样都不能影响它。

### Spica 怎么结束 server

停用插件、重装或升级、改了网络设置要重启、应用正常退出，这几种时候 Spica 都是同一个做法：先关掉 server 的 stdin，等它自己退出；3 秒后还没退，就强行结束 server 这一个进程。Spica 不去找 server 拉起的其他进程。

下表是在 Windows 上实测的（server 用 Node 写；「应用被强行结束」是应用自己一个进程被结束，「整棵进程树被结束」是任务管理器的「结束进程树」或 `taskkill /T /F` 这一类）：

| server 拉起的进程 | 停用、重装、升级、重启、应用退出 | 应用被强行结束 | 整棵进程树被结束 |
|---|---|---|---|
| 用普通方式拉起的（`spawn`，不加 `detached`） | 跟着结束 | 跟着结束 | 跟着结束 |
| `detached: true` 拉起的 | 留着 | 留着 | **被结束** |
| 上面两种再拉起的子进程（例如辅助程序 `.exe` 打开的程序） | 留着 | 留着 | **被结束** |
| 经一个马上退出的中间进程启动的（见下面的写法） | 留着 | 留着 | 留着 |

- 「跟着结束」是 Node 做的：它把用普通方式拉起的直接子进程放进 Windows 的作业对象，父进程一没就全部结束，不管父进程是自己退出的还是被强杀的。这些子进程再拉起的进程不在里面。
- `detached` 不够：进程虽然不跟着 server 结束，可它的父进程还是 server，「整棵进程树被结束」时是顺着父进程往下找的，照样会被找到、结束。一个带 COM 注册的桌面程序被这样结束到一半，用户再开也连不上，只能重启电脑。
- 留下来的进程，当前文件夹如果还在插件的安装文件夹里（不特意设的话，从 server 继承来的就是它），同版本重装时会报「安装文件夹仍被占用」。
- 没有实测、按文档推断的：`"runtime": "binary"` 的 server（自己的 `.exe`）不经过 Node，它拉起的进程在 server 被结束时**都不会**跟着结束，要自己收尾。

### server 和辅助进程：stdin 一关就退出

- server 在 stdin 关闭时自己退出，不要等 Spica 3 秒后强杀。不用 SDK 的写法：`readline.createInterface({ input: process.stdin }).on('close', () => process.exit(0))`。
- 辅助进程也一样：server 给它开一个 stdin 管道，辅助进程读到 stdin 关闭（Node 里是 `process.stdin` 的 `end` / `close` 事件，`.exe` 里是读 stdin 返回 0 字节）就收尾退出。server 无论怎么结束，这根管道都会断，辅助进程就能自己走。
- 辅助进程不要用 `detached`，也不要再拉起要常驻的进程，否则停用后会留着、占着安装文件夹。

### 替用户打开的程序：经一个马上退出的中间进程启动

要让程序的父进程不再是插件：先起一个中间进程，由它启动程序后马上退出。同时把程序的当前文件夹设到插件文件夹外面，并去掉 Spica 给插件进程设的 `ELECTRON_RUN_AS_NODE`（否则用 Electron 做的程序会起不来）。两种写法，任选其一：

```js
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

// Node 写法：中间进程是 Spica 自带的 Node，启动程序后立刻退出
const LAUNCH = `
const [program, cwd, ...args] = process.argv.slice(1);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
require('node:child_process').spawn(program, args, { cwd, env, detached: true, stdio: 'ignore' }).unref();
`;
export function openForUser(program, args = [], cwd = homedir()) {
  spawn(process.execPath, ['-e', LAUNCH, program, cwd, ...args], { stdio: 'ignore', windowsHide: true });
}

// Windows 写法：PowerShell 的 Start-Process（路径经环境变量传，不用处理引号）
export function openForUserPowerShell(program, cwd = homedir()) {
  const env = { ...process.env, OPEN_PROGRAM: program, OPEN_CWD: cwd };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:OPEN_PROGRAM -WorkingDirectory $env:OPEN_CWD'],
    { stdio: 'ignore', windowsHide: true, env });
}
```

- 这两种写法在上表的每一种情况下都实测过：程序都留着、能继续用，同版本重装也不报占用。
- 要从插件自带的 `.exe` 里打开程序，同样经中间进程：例如执行 `powershell.exe -NoProfile -Command "Start-Process -FilePath '<程序>' -WorkingDirectory '<文件夹>'"`。只在 `CreateProcess` 里加 `DETACHED_PROCESS`、`CREATE_NEW_PROCESS_GROUP`、`CREATE_BREAKAWAY_FROM_JOB` 不够：父进程还是你的 `.exe`，整棵进程树被结束时照样会被找到。
- 程序有界面的，不要给它加 `windowsHide` 或 `-WindowStyle Hidden`，否则窗口会被藏起来。
- 程序已经开着时，先找到它再用，不要每次都新开一个。
- 带 COM 注册的真实程序没有实测（用能回应的测试程序代替）。按上表推断：程序不在插件的进程树里，就不会被「结束到一半」。
- `check.mjs` 不查这一条：上面的推荐写法里中间进程本身就用了 `detached`，单看代码分不出对错；辅助程序 `.exe` 里怎么打开程序，在编译好的文件里看不到。交付前按这一节自己核一遍。

## 2e. 同时来的调用和只有一个的东西

- **同一个 server 会同时收到多个 `tools/call`**：几个对话、子任务、插件页面可能同时调你的工具，Spica 默认不排队，来一个发一个。
- **同一个插件可能在同一台电脑上跑好几份**：例如代码版和安装版各开一个，各起一个 server，互相不知道。

工具操作的是只有一个的东西（一个桌面程序的窗口、一个串口、一个只能单独打开的文件）时，两个调用同时进来就会互相打乱。分两层处理：

**这一份 Spica 里：在 `mcp/<id>.json` 声明 `concurrency`。** 值是同时最多处理几个调用（1 或更大的整数，不写就不限）：

```json
{ "runtime": "node", "entry": "server/index.js", "concurrency": 1 }
```

- 多出来的调用按先后排队，前一个结束（成功、出错、被停止都算）才发下一个。对话里调和插件页面调走同一个队列。
- 排队等的时间不算进 `timeout_seconds`，也不算进 `max_call_seconds`：轮到它、真发给 server 时才开始计。
- 排着队时用户点了停止、对话被删，这个调用直接离开队列，server 根本收不到；插件被停用、server 崩溃时，排着的调用都结束并报错。
- 排队时界面上还看不出「在等」，只是这一步还没完成。

**跨 Spica（好几份同时开着）：插件自己用系统的锁。** Node 写的 server 可以拿一个命名管道当锁，同一个名字只有一个进程能占着，占着的进程退出（包括被强行结束）时系统自动放掉：

```js
import net from 'node:net';

// 拿到锁返回一个放锁的函数；别人占着就每半秒再试，最多等 waitMs
export async function takeLock(name, waitMs = 60_000) {
  const path = `\\\\.\\pipe\\${name}`; // Windows 命名管道
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(path, () => resolve(() => new Promise((done) => s.close(() => done()))));
      });
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// 用法
const release = await takeLock('example-plugin-device');
try {
  /* 操作那个只有一个的东西 */
} finally {
  await release();
}
```

- 锁的名字带上插件名，避免和别的插件撞名。等锁时也照常报进度（见 2c 节），否则等太久会被 `timeout_seconds` 停掉。
- 用 `.exe` 写的辅助程序用 Windows 的命名互斥量，例如 C# 的 `new Mutex(false, @"Local\example-plugin-device")` 加 `WaitOne(超时)` / `ReleaseMutex()`；`Local\` 只在当前登录的用户里有效，同一个用户开的几份 Spica 正好都能看到。
- macOS / Linux 上没有命名管道，同样的写法改用临时文件夹里的一个套接字文件；进程崩溃会把文件留下，拿锁失败时先试着连一下，连不上就删掉文件再拿。

## 2f. 重的辅助进程：用到才起，空闲就退

插件启用期间 server 一直开着，它本身很小；占内存的往往是它带的辅助进程（例如打包了数据处理库的 `.exe`，一开就是几十到上百 MB）。一天只用几次的，别让它一直开着：**用到时才拉起，空闲一段时间自己退出，下次调用再拉起。** server 本身照常开着，工具列表不受影响。

```js
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const IDLE_MS = 10 * 60_000; // 空闲 10 分钟就退
const HELPER = join(process.env.SPICA_PLUGIN_DIR, 'bin', 'helper.exe');

let helper; // 正在运行的辅助进程（一个 Promise）；没在运行时是 undefined
let busy = 0; // 正在用它的调用数
let idleTimer;

function startHelper() {
  const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: process.env.SPICA_PLUGIN_DATA });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`辅助进程启动后退出了（代码 ${code}）`)));
    child.stdout.once('data', () => resolve(child)); // 约定：辅助进程准备好时先输出一行
  });
  child.once('exit', () => {
    if (helper === ready) helper = undefined; // 退了（空闲退出或崩溃），下次调用重新拉起
  });
  return ready;
}

/** 用辅助进程做一件事；它没在运行就先拉起。 */
export async function withHelper(job) {
  clearTimeout(idleTimer);
  busy++;
  try {
    const started = (helper ??= startHelper());
    const h = await started.catch((err) => {
      if (helper === started) helper = undefined;
      throw err; // 这次调用报错；下次调用再试着拉起
    });
    return await job(h);
  } finally {
    busy--;
    if (busy === 0) {
      idleTimer = setTimeout(() => {
        helper?.then((h) => h.stdin.end(), () => {}); // 关掉 stdin，让它收尾后自己退出
      }, IDLE_MS);
    }
  }
}
```

- 这段代码实测过：空闲期内的调用用同一个进程，两个同时来的调用共用它，空闲到点后进程退出，下一次调用拉起新的照常完成；拉起失败时这次调用报错，下一次会重新尝试。
- **退出前收尾**：辅助进程读到 stdin 关闭就把手上的事做完、写完文件再退出，和 2d 节的辅助进程是同一条规矩。Spica 停掉 server 时，这根管道也会断，辅助进程同样会退。
- **拉起失败要说清楚**：工具返回 `isError: true` 和一句人话，例如「[HELPER_START_FAILED] 数据处理组件没能启动，详见插件日志」，具体原因写 stderr。不要让 server 跟着崩溃。
- **第一次调用会慢一些**：拉起要时间。拉起时间可能比 `timeout_seconds` 的一大半还长的，拉起期间也报进度（见 2c 节），或者把 `timeout_seconds` 设大一点。
- 当前文件夹设在 `SPICA_PLUGIN_DATA`，不放在插件安装文件夹里（见 2d 节：留在安装文件夹里的进程会让重装报「仍被占用」）。
- 退出的时间按使用习惯定：一天用几次的 10 到 30 分钟；拉起特别慢的可以更长。


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
