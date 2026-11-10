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
| `license` | 否 | 如 `Apache-2.0` |
| `compatibility.spica` | 否 | 如 `>=0.1.0` |
| `permissions.network` | 否 | 会访问的主机名单（现在只展示） |
| `permissions.workspace` | 否 | `none`（默认）/ `read` / `write`：对项目文件夹的访问 |
| `permissions.irreversible` | 否 | 不可撤销的工具（server 里的原名），每次调用前问用户 |
| `permissions.hooks` | 否 | 用到的钩子类型；没写的不生效 |
| `mock` | 否 | `{ "supported": true, "description": "模拟时会怎样" }` |
| `mail` | 否 | 邮件来源声明，见 `mail.md` |

## `mcp/<id>.json` / `services/<id>.json`

```json
{ "runtime": "node", "entry": "server/index.js", "args": [], "env": {}, "timeout_seconds": 30, "restart": { "max_restarts": 3, "window_seconds": 60 } }
```

- `runtime`：`node`（用 Spica 自带的 Node 跑）或 `binary`（插件自带的 `.exe`）。Python 这一版请打成 `.exe`。
- `entry`：插件文件夹里的相对路径；不能用 `.cmd/.bat/.ps1/.vbs`（会弹黑窗口）。
- `env` 里不能自己设 `SPICA_` 开头的变量。
- 插件只有一个 `mcp/` server 时，工具名是 `<插件名>__<工具>`；有多个时是 `<插件名>-<id>__<工具>`。

Spica 启动 server 时给的环境变量：`SPICA_PLUGIN_DATA`（唯一能写的文件夹，升级、回滚都保留）、`SPICA_PLUGIN_DIR`（安装目录，只读）、`SPICA_MOCK`（`1` = 模拟模式）、`SPICA_PLUGIN_NAME`、`SPICA_PLUGIN_VERSION`。另外给应用的网络设置：代理（`HTTPS_PROXY` 等，加 `NODE_USE_ENV_PROXY=1`）和信任的证书（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 等），见 `internal-services.md`。其他环境变量只继承白名单（PATH、TEMP、用户目录这类），像密钥的名字一律不传，所以凭据不要从环境变量读。

## `views/<id>.json`

```json
{ "title": "Board", "entry": "ui/index.html", "placement": "sidebar", "icon": "ui/icon.svg", "permissions": { "tools": ["list_items"] } }
```

见 `ui.md`。
