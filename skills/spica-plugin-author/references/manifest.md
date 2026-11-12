# 目录结构和清单字段

完整说明：Spica 仓库 `docs/design/plugins.md` 第 2 节、`docs/plugins/authoring.md` 第 1–5b 节。这里是写插件时要查的部分。

## 目录

```
<name>/
  manifest.json          必须
  package.json           Node server 要有，写 "type": "module"（别在 .spicaignore 里排除它）
  .spicaignore           不进包的开发文件，写法同 .gitignore（不支持 !）：test/、dist/
  mcp/<id>.json          MCP server 声明，工具给模型用
  services/<id>.json     常驻进程声明，工具默认不给模型，只给自己的页面用
  server/…               server 代码
  mock/…                 模拟数据（全部虚构）
  skills/<id>/SKILL.md   技能（--- 块里写 name、description）
  commands/<id>.md       命令：用户敲 /<插件>:<id>，正文里 $ARGUMENTS 换成参数
  hooks/*.js | *.mjs     钩子
  views/<id>.json        页面声明
  ui/…                   页面文件
  test/…                 测试（不进包）
```

## `manifest.json`

| 字段 | 必填 | 说明 |
|---|---|---|
| `manifest_version` | 是 | `1` |
| `name` | 是 | 小写字母、数字、`-`，2–24 字符，以字母开头；工具名前缀，定了别改 |
| `version` | 是 | 三段数字，如 `0.1.0`；发新版就加 |
| `description` | 是 | 一句话 |
| `author` | 是 | `{ "name": "…" }` |
| `display_name` | 否 | 界面上的名字 |
| `icon` | 否 | 插件自己的图标：插件文件夹里的 `.svg`，不大于 64 KB；浅色和深色皮肤各一款时写 `{ "light": …, "dark": … }`。见下面「插件图标」 |
| `license` | 否 | 如 `Apache-2.0` |
| `compatibility.spica` | 否 | 如 `>=0.1.0` |
| `permissions.network` | 否 | 会访问的主机名单（现在只展示） |
| `permissions.workspace` | 否 | `none`（默认）/ `read` / `write`：对项目文件夹的访问 |
| `permissions.irreversible` | 否 | 不可撤销的工具（server 里的原名，mcp/ 和 services/ 的都算），每次调用前问用户 |
| `permissions.hooks` | 否 | 用到的钩子类型；没写的不生效 |
| `permissions.model` | 否 | 借用户在 Spica 里配好的模型：`{ "reason": "一句为什么", "max_usd_per_day": 0.2 }`，上限缺省 0.5 美元/天。见 `model.md`（rc.2 之后的版本才有） |
| `mock` | 否 | `{ "supported": true, "description": "模拟时会怎样" }` |
| `mail` | 否 | 邮件来源声明，见 `mail.md` |

## 插件图标

设置 › 插件 的列表和详情里，插件名前面的图标。不写 `icon` 时显示名字的第一个字。

```json
"icon": "icon.svg"
```

浅色皮肤和深色皮肤各用一款时：

```json
"icon": { "light": "icon-light.svg", "dark": "icon-dark.svg" }
```

- 只给一款：两种皮肤都用它。给两款：`light` 用在浅色皮肤，`dark` 用在深色皮肤，两个都要写；他换皮肤时图标跟着换。
- 只收 `.svg`；插件文件夹里的相对路径，不能用 `..`、绝对路径；文件要存在；每个不大于 64 KB。写错了插件装不上，提示里写是 `icon`、`icon.light` 还是 `icon.dark`。
- 按 24×24 画、画满，显示成 22 像素见方的圆角方块。
- 只当图片显示：脚本、事件属性、外部链接都不生效，`check.mjs` 会提醒删掉。
- 颜色写死，不跟随明暗（`currentColor` 是黑色）。只给一款时深浅两种皮肤上都要看得清，带底色的方块最稳；分开给就各按各的底色画。页面的 `icon` 跟随主题，两者不同。
- `scaffold.mjs` 生成的插件自带浅色、深色两款（`icon-light.svg`、`icon-dark.svg`）；例子见 `plugins/example-notes` 的这两个文件。

## `mcp/<id>.json` / `services/<id>.json`

```json
{ "runtime": "node", "entry": "server/index.js", "args": [], "env": {}, "timeout_seconds": 30, "restart": { "max_restarts": 3, "window_seconds": 60 } }
```

- `runtime`：`node`（用 Spica 自带的 Node 跑）或 `binary`（插件自带的 `.exe`）。Python 这一版请打成 `.exe`。
- `entry`：插件文件夹里的相对路径；不能用 `.cmd/.bat/.ps1/.vbs`（会弹黑窗口）。
- `env` 里不能自己设 `SPICA_` 开头的变量。
- `timeout_seconds`：多久没有结果、也没有进度就算失败（缺省 60）。`max_call_seconds`：工具一直在报进度时最多等多久（缺省 3600）。要跑很久的工具要报进度，写法见下面「要跑很久的工具」。
- `concurrency`：同时最多处理几个工具调用（1 或更大的整数，不写就不限）。操作只有一个的东西（一个程序的窗口、一个串口）时写 `1`，多出来的调用排队，排队时间不算超时。好几份 Spica 同时开着时，跨应用的独占要插件自己用系统的锁，写法见作者指南 2e 节。
- 插件只有一个 `mcp/` server 时，工具名是 `<插件名>__<工具>`；有多个时是 `<插件名>-<id>__<工具>`。

Spica 启动 server 时给的环境变量：`SPICA_PLUGIN_DATA`（插件自己的数据文件夹，升级、回滚都保留；除了它只写用户在对话里点名的文件夹，见 `hooks-permissions.md`「写文件」）、`SPICA_PLUGIN_DIR`（安装目录，只读）、`SPICA_MOCK`（`1` = 模拟模式）、`SPICA_PLUGIN_NAME`、`SPICA_PLUGIN_VERSION`、`SPICA_USER_ACCOUNT`（用户的账号：Windows 用户文件夹名转大写，`C:\Users\alex.chen` → `ALEX.CHEN`，用户在设置里改过就是改过的；取不到时为空。要账号一律读它，不要自己从 `USERPROFILE`、`USERNAME`、`os.userInfo()` 取）。另外给应用的网络设置：代理（`HTTPS_PROXY` 等，加 `NODE_USE_ENV_PROXY=1`）和信任的证书（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 等），见 `internal-services.md`。其他环境变量只继承白名单（PATH、TEMP、用户目录、`COMPUTERNAME`、`USERNAME` 这类；取电脑名也可以用 `os.hostname()`），像密钥的名字一律不传，所以凭据不要从环境变量读。

### 要跑很久的工具

批量下载、导出这类一次要几分钟到几十分钟的工具，要报进度，否则 `timeout_seconds` 一到就被停掉：

```js
const token = msg.params._meta?.progressToken;   // Spica 调工具时带；没有就不报
send({ method: 'notifications/progress', params: { progressToken: token, progress: done, total: all, message: `${done}/${all} 个文件` } });
```

- 隔 10 到 30 秒报一次；`progress` 必须越来越大。
- 收到 `notifications/cancelled`（`params.requestId` 是这次调用的 id）就停手，不用再回结果；已写好的文件留着，下次跳过已有的接着做。
- 用官方 SDK：`extra._meta?.progressToken`、`extra.sendNotification(...)`，取消看 `extra.signal`。
- 一直报进度也最多等 `max_call_seconds`（缺省 3600）；更长的活拆成「开始 / 查进度 / 取结果」几个工具。插件页面直接调工具也按这套规矩等。
- `preview.mjs` 和 `check.mjs` 也按这套规矩等。

## `views/<id>.json`

```json
{ "title": "Board", "entry": "ui/index.html", "placement": "sidebar", "icon": "ui/icon.svg", "permissions": { "tools": ["list_items"] } }
```

`placement` 还可以是 `panel`（对话旁边的面板）、`preview`（给某几种文件当预览，要写 `preview: { extensions, max_mb }`）、`settings`（设置 › 插件 里这个插件详情的一个页签）。见 `ui.md`。
