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

浅色皮肤和深色皮肤要用不同的图标时，写成两款：

```json
"icon": { "light": "icon-light.svg", "dark": "icon-dark.svg" }
```

- 只给一款，两种皮肤都用它；给两款，`light` 用在浅色皮肤、`dark` 用在深色皮肤，两个都要写，用户换皮肤时图标跟着换。
- 只收 `.svg`，写插件文件夹里的相对路径（不能用 `..`、绝对路径），文件要存在，每个不能大于 64 KB。和页面的 `icon` 是同一套路径规矩。
- 按 24×24 画，显示时缩成 22 像素见方的圆角方块，所以四周不用留白，形状画满。
- 图标只当图片显示：里面的脚本、事件属性（`onload` 之类）、外部链接都不会生效，`check.mjs` 看到会提醒删掉。
- 颜色写死在图标里，不跟随 Spica 的明暗（`currentColor` 在这里是黑色）。只给一款时深色和浅色两种皮肤上都要看得清，最稳的是带底色的方块；分开给两款就各按各的底色画。页面的 `icon`（`views/*.json`）不同，它画在侧栏里，跟随主题用 `currentColor`。
- 写错了（路径、类型、大小）插件装不上，提示里写清是哪一条。
- 例子：`plugins/example-notes/icon-light.svg` 和 `icon-dark.svg`；脚手架 `scaffold.mjs` 生成的插件自带这样两款，换成自己的就行。

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
- 工具可以在结果里返回图片（`{ type: 'image', data: <base64>, mimeType: 'image/png' }`）和音频（`type: 'audio'`），MCP 规范的写法。Spica 把它们存成文件放在这次对话的文件夹里（对话删了一起删），每个出一张文件卡；模型看到一行「图片：<路径>」或「音频：<路径>（模型听不到内容）」。PNG、JPEG、GIF、WEBP 的图片在当前模型能看图时一起发给模型（太大的先缩小），别的格式只出卡。插件页面直接调工具时不保存，页面拿到的还是「[image … omitted]」。
- 返回结构化结果（`structuredContent`）时，照规范在 `content` 里同时放一份同样的 JSON 文字：有 `content` 时模型只读得到 `content`，`structuredContent` 只在没有别的内容时才给模型。
- 进程崩溃 Spica 会自动重启，但 60 秒内超过 3 次就停（可在声明里用 `restart` 改）。
- Python 写的 server：这一版请用 PyInstaller 之类打成 `.exe`，声明写 `"runtime": "binary"`、`"entry": "bin/server.exe"`。别用 `.bat` / `.cmd` 启动，会弹黑窗口，Spica 会拒绝。

## 2b. 把文件写到用户点名的文件夹

插件自己的数据放 `SPICA_PLUGIN_DATA`。下载、导出一类插件的本职是把文件放到用户指定的地方：**用户在对话里明确给出的文件夹可以写**，按下面几条做：

- 文件夹由工具参数传进来（例如 `dest_folder`，写进 `required`），参数说明写明「用户在对话里给出的文件夹，不要自己猜」。没给就返回错误请用户说一个，不要退回到某个默认的外部文件夹。
- 只写这个文件夹和它下面：先解析成绝对路径，文件名里带 `..`、盘符或绝对路径的一律拒绝，不往上一级、别的盘或别的文件夹写。文件夹不存在就按用户给的路径建出来，不换地方。
- 结果里原样写出实际写到的完整路径和文件名，让用户看得到东西放在哪。
- 每个写出的文件，在结果的 `content` 里再附一项 MCP 标准的 `resource_link`，Spica 就会在对话里给它出一张文件卡（能预览、能用系统程序打开），一次调用几个文件就几张：

  ```js
  import { basename } from 'node:path';
  import { pathToFileURL } from 'node:url';
  content.push({ type: 'resource_link', uri: pathToFileURL(fullPath).href, name: basename(fullPath), mimeType: 'application/pdf' });
  ```

  `uri` 必须是本机已存在文件的 `file://` 地址（用 `pathToFileURL` 生成，盘符、共享盘路径、空格和中文都能处理）。模型看到的是一行「文件：<完整路径>」；指到文件夹、指到不存在的文件、不是 `file://` 的，不出卡，模型看到「文件夹：」「文件（不存在）：」「链接：」开头的一行。插件页面直接调工具时没有卡，拿到的文字也是这几行。
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

停用插件、重装或升级、改了网络设置要重启、应用正常退出，这几种时候 Spica 都是同一个做法：先记下 server 拉起的全部进程（它的子进程、子进程的子进程……），再关掉 server 的 stdin，等它自己退出；3 秒后 server 还没退就强行结束它；server 没了以后，记下的进程再给最多 1 秒收尾，还活着的逐个结束。所以停一次插件要多花查一次进程的时间（实测约 1.4 秒，在一台同时开着很多程序的电脑上）；接连停好几个插件时（例如应用退出）共用一次。

记名单时是顺着「谁是谁的父进程」找的：交给 Windows 打开的程序（父进程是 Windows 自己的进程），以及经一个已经退出的中间进程启动的程序，都不在名单里，Spica 不会碰它们。结束前会核对进程的创建时间，同一个编号被别的程序重新用了的不会误杀。这只在 Windows 上做；其他系统上 Spica 只结束 server 自己。查不了进程时（例如电脑上禁用了 PowerShell）也只结束 server，并在插件日志里写一行。电脑特别忙、3 秒内还没查完时，Spica 先照常停 server，查完再收；这时 server 直接拉起的进程照样会被结束，它们再拉起的可能漏掉。server 自己崩溃退出时不查，它留下的进程要等插件下次被停时才会被收。

已知的限制：刚打开程序的那一刻正好停插件会怎样，看你是怎么打开的。交给 Windows 打开的（见下面），程序可能没打开，但不会被结束；经自己写的中间进程打开的，中间进程还没来得及退出时（实测 Node 写法约 0.2 秒，PowerShell 写法约 0.6 秒），那个程序会被当成插件的进程结束。

下表是在 Windows 上实测的（server 用 Node 写；「应用被强行结束」是应用自己一个进程被结束，「整棵进程树被结束」是任务管理器的「结束进程树」或 `taskkill /T /F` 这一类）：

| server 拉起的进程 | 停用、重装、升级、重启、应用退出 | 应用被强行结束 | 整棵进程树被结束 |
|---|---|---|---|
| 用普通方式拉起的（`spawn`，不加 `detached`） | 结束 | 结束 | 结束 |
| `detached: true` 拉起的 | **结束**（server 没了 1 秒后） | 留着 | 结束 |
| 上面两种再拉起的子进程（例如辅助程序 `.exe` 打开的程序） | **结束**（server 没了 1 秒后） | 留着 | 结束 |
| 交给 Windows 打开的（explorer.exe 或 WMI，见下面的写法），或经一个马上退出的中间进程启动的 | 留着 | 留着 | 留着 |

- 「跟着结束」是 Node 做的：它把用普通方式拉起的直接子进程放进 Windows 的作业对象，父进程一没就全部结束，不管父进程是自己退出的还是被强杀的。这些子进程再拉起的进程不在里面。
- `detached` 不能让程序留下来：它的父进程还是 server，停插件时在名单里，「整棵进程树被结束」时也是顺着父进程找到的。一个带 COM 注册的桌面程序被这样结束到一半，用户再开也连不上，只能重启电脑。
- 「应用被强行结束」时 Spica 来不及做任何事，留下来的进程当前文件夹如果在插件的安装文件夹里（不特意设的话，从 server 继承来的就是它），之后同版本重装会报「安装文件夹仍被占用」。
- `"runtime": "binary"` 的 server（自己的 `.exe`）拉起的进程，停插件时一样会被记下、结束（名单不看是谁写的）；按文档推断、没有实测的是：它们不会在 server 被强杀的那一刻跟着结束，要再过 1 秒。

### server 和辅助进程：stdin 一关就退出

- server 在 stdin 关闭时自己退出，不要等 Spica 3 秒后强杀。不用 SDK 的写法：`readline.createInterface({ input: process.stdin }).on('close', () => process.exit(0))`。
- 辅助进程也一样：server 给它开一个 stdin 管道，辅助进程读到 stdin 关闭（Node 里是 `process.stdin` 的 `end` / `close` 事件，`.exe` 里是读 stdin 返回 0 字节）就收尾退出。server 无论怎么结束，这根管道都会断，辅助进程就能自己走。
- 辅助进程不要用 `detached`，也不要再拉起要常驻的进程：Spica 会把它们记下，server 没了 1 秒后强行结束，来不及收尾；应用被强行结束时它们还会留着、占着安装文件夹。

### 替用户打开的程序：交给 Windows 去打开

这是硬要求，有两条：

1. **程序不能挂在插件下面。** 插件自己拉起的进程（包括加了 `detached` 的）停用、重装、升级插件或应用退出时，都会被 Spica 结束。
2. **程序要拿到用户完整的环境变量。** 插件进程只继承白名单里的环境变量（见第 2 节的变量表）。插件自己启动的程序，或者经插件起的中间进程启动的程序，拿到的也只有这些；靠环境变量找配置、找组件的程序会报找不到配置，或者干脆起不来。

所以不要自己当程序的父进程，交给 Windows 去打开。两种写法，程序的父进程都是 Windows 自己的进程，拿到的都是用户的整套环境变量（两种写法实测逐个变量相同，插件设的变量一个都不带过去）：

```js
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// 首选：经 explorer.exe 打开，和用户双击这个程序一样。不能带参数。
export function openForUser(program) {
  if (!/\.exe$/i.test(program) || program.includes(',') || !existsSync(program)) throw new Error('not a program that explorer.exe can open: ' + program);
  spawn('explorer.exe', [program], { stdio: 'ignore' });
}

// 要带参数、指定当前文件夹或者要进程号时：经 WMI 的 Win32_Process.Create 打开。返回程序的进程号。
export function openForUserWithArgs(program, args = [], cwd = homedir()) {
  for (const a of [program, ...args]) if (a.includes('"')) throw new Error('quotes are not supported: ' + a);
  const commandLine = [program, ...args].map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:OPEN_CMD; CurrentDirectory = $env:OPEN_CWD }; "$($r.ReturnValue) $($r.ProcessId)"'],
      { windowsHide: true, env: { ...process.env, OPEN_CMD: commandLine, OPEN_CWD: cwd } },
      (err, stdout) => {
        const [code, pid] = String(stdout).trim().split(' ').map(Number);
        if (err || code !== 0) reject(new Error(`could not start ${program} (Win32_Process.Create returned ${code})`));
        else resolve(pid);
      },
    );
  });
}
```

- 这两段代码原样放进测试插件，在上表的七种情况下（停用、同版本重装、升级、改网络设置重启、应用正常退出、只强行结束应用、整棵进程树被结束）都实测过：程序都留着、能继续用，同版本重装也不报占用。有插件作者用 explorer.exe 的写法打开真实的、带 COM 的桌面客户端，在现在的版本上把七种情况都核过：程序都是同一个进程、保持登录、COM 正常。WMI 的写法也有插件作者用真实的带窗口、带 COM 的程序试过打开（返回 0、拿到进程号、程序拿到了用户完整的环境），七种情况没有在这个写法上核。
- 要从插件自带的 `.exe` 里打开程序，做法一样：执行 `explorer.exe "<程序>"`，或者执行上面那行 PowerShell（`Invoke-CimMethod -ClassName Win32_Process -MethodName Create ...`）。
- 程序已经开着时，先找到它再用，不要每次都新开一个。

**经 explorer.exe 打开：限制**（在一台 Windows 11 上实测）

- 没有查到微软写这种用法的文档：查到的 explorer.exe 命令行说明（微软知识库文章 Q130510「Command-Line Switches for Windows Explorer」）只写了 `/n`、`/e`、`/root`、`/select` 这几个开关。下面都是实测到的行为，以后的 Windows 版本可能变。
- 不能带参数：命令行里程序后面再写参数，程序不会启动，反而会打开一个文件夹窗口。路径里有逗号也一样（explorer 把逗号当分隔符）。带空格、中文的路径没问题。
- 看不出成没成功，也拿不到进程号：你起的 explorer.exe 不管成没成功退出码都是 1，约 0.3 到 0.5 秒就退出。要确认程序开了，自己按程序的路径去找进程。
- 路径不对时不报错，可能开一个文件夹窗口或者弹框（没有实测），所以调用前先确认路径存在、是 `.exe`，上面的代码就是这样做的。
- 程序的当前文件夹是 `C:\Windows\System32`，改不了。程序要特定的当前文件夹时，用 WMI 的写法。
- 程序的父进程是 Windows 为这次打开另起的一个 explorer（命令行带 `/factory` 和 `-Embedding`），不是你起的那个，也不是桌面那个。它几分钟内自己退出（实测 1 到 3 分钟），程序照常开着。
- 调用后你起的 explorer.exe 还没退出时（约 0.3 秒内）正好停插件，explorer.exe 会被当成插件的进程结束，程序就不会打开。不会出现程序打开了又被结束到一半。
- Spica 以管理员身份运行时，打开的程序是什么权限，没有实测。

**经 WMI 打开：限制**

推荐：继续首选 explorer.exe；WMI 只在要带参数或指定当前文件夹时用，用之前先在目标电脑上确认程序不受它所在的作业对象限制（办法见下面「作业对象」那条）。

- 这是有文档的做法（Win32_Process 类的 Create 方法）。返回 0 是成功，2 是拒绝访问，3 是权限不够，9 是找不到路径，21 是参数不对；成功时给出程序的进程号。
- 参数里不能有双引号（上面的代码会拒绝）；带空格的参数自动加上引号。参数、中文路径、当前文件夹都实测过。带空格又以反斜杠结尾的参数（例如 `C:\某个 文件夹\`）加了引号后，末尾的反斜杠会吃掉引号，参数就错了：先去掉末尾的反斜杠再传（按 Windows 的命令行规则推断，没有实测）。
- 程序的父进程是 Windows 的 WMI 服务进程（WmiPrvSE）。它什么时候退出因机器而异：我们这台上很快就退出，程序照常开着；另一台 Windows 11 上 2.5 分钟后还没退出。
- 作业对象：文档写着用这个方法起的进程「受作业对象限制，除非加 `CREATE_BREAKAWAY_FROM_JOB`」。程序在不在作业对象里因机器而异：我们这台 Windows 11 上不在，另一台 Windows 11 上在。在作业对象里时有两个风险：大程序可能受 WMI 的配额限制；作业对象要是设了「关闭即结束」（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），WmiPrvSE 退出时程序可能被一起结束。这两样都还没有观察到，也没有排除。检查办法：在目标电脑上用 WMI 打开一次程序，记下程序的父进程号（`Get-CimInstance Win32_Process -Filter "ProcessId=<进程号>"` 的 `ParentProcessId`，就是那个 WmiPrvSE），等这个进程退出（可能要好几分钟）后看程序还在不在、还能不能用。WmiPrvSE 一直不退就看不出来，这时按有风险算，改用 explorer.exe。文档给的另一个办法是在 `Win32_ProcessStartup` 的 `CreateFlags` 里加 `CREATE_BREAKAWAY_FROM_JOB`（16777216）：我们这台上加了照样能打开（这台本来就不在作业对象里），在程序会进作业对象的电脑上没有测过，作业对象不许脱离时可能直接打不开。
- 公司电脑上的安全软件常盯着「WMI 服务拉起程序」这种行为，可能拦下或者报警。用之前在目标电脑上试一次。
- 每次要多起一个 PowerShell，一次的用时因机器而异：我们这台约 1.3 到 1.5 秒，另一台约 0.5 秒（实测）。PowerShell 还没调到 WMI 时正好停插件，程序不会打开；调到之后程序已经不在插件下面了，不会被结束（这一条是按父进程推断的，没有单独实测）。

**不推荐：自己写中间进程**

以前这一节推荐过两种中间进程写法：Node 写法，中间进程 `detached` 启动程序后马上退出；PowerShell 的 `Start-Process`。它们照样能让程序不挂在插件下面（七种情况实测都留着），但程序拿到的是插件的环境变量（白名单，加上 `SPICA_` 开头的那些），会碰到上面第 2 条的问题。只有程序不靠环境变量、而且上面两种写法都用不了时才这样做。这时要给程序重建整套用户环境，不要只补几个变量：

- 不要用 `Start-Process -UseNewEnvironment`：它给的环境实测只有 40 个变量，缺 `SystemRoot`、`USERPROFILE`、`APPDATA`、`ProgramFiles` 这些，`PATH` 也不全；测试程序在这份环境里一启动就崩了。
- 在 `.exe` 里可以用 Windows 的 `CreateEnvironmentBlock`（传当前进程的令牌，`bInherit` 传 `FALSE`），得到的是用户登录时的整套环境；实测它比 explorer 打开时少 `USERNAME` 和 `USERDOMAIN` 两个，从自己的环境里补上。再把这份环境传给 `CreateProcess`（要加 `CREATE_UNICODE_ENVIRONMENT`）。这一条只核对过拿到的环境变量，没有跑上面的七种情况。
- 中间进程还没退出时（实测 Node 写法约 0.2 秒，PowerShell 写法约 0.6 秒）正好停插件，那个程序会被当成插件的进程结束。
- 当前文件夹要设到插件文件夹外面，并去掉 Spica 给插件进程设的 `ELECTRON_RUN_AS_NODE`（否则用 Electron 做的程序会起不来）。只在 `CreateProcess` 里加 `DETACHED_PROCESS`、`CREATE_NEW_PROCESS_GROUP`、`CREATE_BREAKAWAY_FROM_JOB` 不够：父进程还是你的 `.exe`。
- 程序有界面的，不要给它加 `windowsHide` 或 `-WindowStyle Hidden`，否则窗口会被藏起来。

`check.mjs` 不查这一条：插件里怎么打开程序，单看代码分不出是辅助进程还是替用户打开的程序；辅助程序 `.exe` 里怎么打开程序，在编译好的文件里看不到。交付前按这一节自己核一遍。

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

插件可以带自己的界面，Spica 把它放进侧栏（`sidebar`）、对话旁边的面板（`panel`），或 设置 › 插件 里这个插件的详情（`settings`，见下面「设置页」）。声明 `todo/views/board.json`：

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
| `openFile(路径)` | 在 Spica 的预览栏打开文件（只限本插件目录里的，或这次会话里见过的） |
| `notify(文字, { kind })` | 弹一条提示，`kind` 是 `info` 或 `error` |
| `pickFolder({ title?, defaultPath? })` | 弹系统的选文件夹框 → 用户选的完整路径，取消时 `null` |
| `pickFile({ title?, defaultPath?, extensions? })` | 弹系统的选文件框（选一个）→ 完整路径或 `null`；`extensions` 如 `[".md", ".txt"]`，不写 = 任何文件 |
| `openFolder(路径)` | 在系统的资源管理器里打开一个文件夹 → 打不开时报错（文字说原因，如「找不到文件夹：…」）。只认本机盘符开头的完整路径，网络路径、文件都不行 |

- 颜色用 Spica 注入的 CSS 变量：`--spica-bg`、`--spica-surface`、`--spica-fg`、`--spica-muted`、`--spica-border`、`--spica-accent`、`--spica-danger`、`--spica-font`、`--spica-radius`。换明暗时它们会自动变，不用自己判断。
- 沙箱限制：页面里没有 Node，不能 `require`、不能读写文件；只能加载本插件目录里的文件（不能用 CDN，脚本和样式都放进插件）；只能调本插件的工具，写了 `permissions.tools` 就只能调列出的那几个。
- `permissions.irreversible` 里的工具（services/ 里的也算），页面调用时 Spica 会先弹确认框；用户拒绝时 `isError` 为真，`content` 以 `[CONFIRM_REQUIRED]` 开头。
- 页面能调常驻进程（`services/`）的工具：这类工具不给模型、只给自己的页面用，适合做界面专用的接口。
- `sidebar` 是侧栏里一个入口、点开占主区域，适合完整的功能页；`panel` 是窗口最右「详情」那一栏顶上的一个标签（「详情 / 你的页面」），适合边聊边用的小工具：这一栏固定 300px 宽，不能拖宽，也不能盖住对话，按 300px 宽设计。一个插件可以有多个页面。

### 设置页（`placement: "settings"`）

插件要用户填的东西（服务地址、令牌、保存到哪个文件夹）放在自己的设置页里：显示在 设置 › 插件 › 这个插件的详情里：名字和「更新 / 删除」那两行下面多一行页签，第一个是「详情」，后面每个设置页一个，页签文字是 `title`。点它，下面整块换成这个页面，占满右栏剩下的高度；侧栏不多出入口，插件停用时不显示。页面第一次点到它的页签才加载，切回「详情」再回来，填了一半的东西还在。

```json
{
  "title": "设定",
  "entry": "ui/settings.html",
  "placement": "settings",
  "permissions": { "tools": ["get_settings", "save_settings"] }
}
```

- 可以有几个设置页，各占一个页签。规则和别的页面一样：沙箱、只能调本插件的工具、`permissions.tools` 生效。
- 页面自己滚：内容比右栏高时，页面里出滚动条，外面的右栏不滚。
- 设置页里 `--spica-bg` 是详情卡片的底色（页面和卡片连成一片），`--spica-surface` 是窗口的底色：按钮、输入框用 `--spica-surface`，在卡片上照样看得出来。
- 读写设置的工具放进 `services/`（只给自己的页面用，模型看不到，「保存令牌」不会被 Agent 误调），存进 `SPICA_PLUGIN_DATA/config.json`；给模型用的 server 每次调用时读同一个文件。写法见 skill 的 `references/internal-services.md`。

要用户选文件夹时，照 Spica 自己 设置 › 常规 › 工作流 那一行：输入框后面两个方形图标按钮，文件夹图标是「打开文件夹」，铅笔是「选择文件夹」（更改），名字放进 `title` 悬停显示：

```html
<div class="field-row">
  <input id="folder" type="text">
  <button type="button" class="icon" id="open" title="打开文件夹" aria-label="打开文件夹" disabled>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z"/></svg>
  </button>
  <button type="button" class="icon" id="pick" title="选择文件夹" aria-label="选择文件夹">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9z"/></svg>
  </button>
</div>
```

```js
pick.onclick = async () => {
  const dir = await window.spica.pickFolder({ title: '选择笔记文件夹', defaultPath: box.value || undefined });
  if (dir === null) return;   // 用户取消：什么都不改
  box.value = dir;            // 填回页面；用户点「保存」时经自己的工具存
};
open.onclick = () => window.spica.openFolder(box.value).catch((err) => showError(err.message));
box.oninput = () => (open.disabled = !box.value.trim());   // 框里空着时「打开」不能点
```

图标按钮的样式（`button.icon`：32px 见方、和旁边输入框一样高，图标 16px、线宽 1.4、用文字颜色）在 `plugins/example-notes/ui/style.css`，可以照抄。

- 只给路径，读写还是插件自己的工具（钩子、确认照常生效）。不用在清单里声明：页面能拿到本机的完整路径，只因为用户自己在系统对话框里选了它。
- 对话框挂在 Spica 窗口上，标题前加插件名（「Notes (example) · 选择笔记文件夹」）。同一时间只开一个，对话框开着时再要一个，直接得到 `null`。
- `defaultPath` 只认本机盘符开头的完整路径（`D:\…`），网络路径（`\\server\share`）和别的写法会被忽略，对话框从它自己的位置开始。
- sidebar、panel 的页面也能用；预览页不能（它拿着用户的文件）。
- `openFolder` 只是在资源管理器里打开，不读、不执行任何东西：只认本机盘符开头的文件夹，网络路径（`\\server\share`）直接报错，给的是文件或文件夹不存在时报「找不到文件夹：…」。预览页不能用。
- 完整例子：`plugins/example-notes` 的 `views/settings.json`、`services/settings.json`、`server/settings.js`、`ui/settings.html`。

### 预览页（`placement: "preview"`）

给某几种文件做「预览」（例如更像原样的 Word、Excel）：用户在 设置 里选了用它预览这种文件后，对话右边的预览栏打开这种文件时显示这个页面（可以拖宽、可以盖住对话），Spica 把**这一个文件**交给它。没选的时候用 Spica 自带的预览。

```json
{
  "title": "Word 原样预览",
  "entry": "ui/docx.html",
  "placement": "preview",
  "preview": { "extensions": [".docx", ".docm"], "max_mb": 30 }
}
```

- `extensions`：小写、带点的扩展名。不能有 `.pdf` 和图片，这些 Spica 自己就能原样显示。
- `max_mb`：能处理的最大文件，1 到 100，不写是 20。文件更大时 Spica 用自带的预览。
- 预览页不写 `permissions.tools` 就**不能调**本插件的工具（和别的页面相反）：它拿着用户的文件，别顺手交给 server。

页面里这样拿文件（桥接口由 Spica 的界面提供）：

```js
const file = await window.spica.preview.file(); // { name, size, modifiedAt, extension, bytes: ArrayBuffer }，没有完整路径
render(file.bytes);
window.spica.preview.ready();                    // 画好了
// 画不了时：window.spica.preview.fail('看不懂这个文件');  Spica 改用自带预览，并显示这句
window.spica.onEvent((e) => { if (e.type === 'preview.file') location.reload(); }); // 用户换了一个文件
```

- 15 秒内没调 `ready()`，或者页面出错、崩溃，Spica 也改用自带的预览。
- 拿不到别的文件，写不回去，照样不能联网；库文件放进插件，别从网上加载。
- 完整例子：`plugins/office-preview`（Word、Excel 原样预览，两个预览页，库在 `ui/vendor/`，来源和校验值在 `THIRD-PARTY.md`）。
- 完整例子：`plugins/example-notes` 的 `views/notebook.json`（sidebar）、`views/quick-note.json`（panel）、`views/settings.json`（settings），页面在 `ui/`。

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
