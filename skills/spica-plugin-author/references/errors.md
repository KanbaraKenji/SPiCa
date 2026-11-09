# 错误码

## 你的工具怎么报错

- 出错时不要崩溃，返回 `isError: true` 的结果，文字以错误码开头：`[ITEM_NOT_FOUND] 找不到这一条。可以先用 list_items 看有哪些。`
- 错误码用大写英文加下划线，写在 `server/errors.js` 的 `MESSAGES` 里，一个码一句中文人话：先说发生了什么，再说用户或模型下一步该怎么做。
- 不要把正文、文件内容、个人信息、密钥写进错误文字或日志。
- 常用的码（模板里已有）：

| 码 | 什么时候 |
|---|---|
| `INVALID_ARGUMENT` | 参数缺了或不对 |
| `ITEM_NOT_FOUND` | 要找的东西不存在 |
| `SERVICE_UNREACHABLE` | 连不上真服务（提示可以开模拟模式） |
| `NOT_CONFIGURED` | 还没配置服务地址等 |
| `INTERNAL` | 其他意外，详情写进 stderr（插件日志） |

## Spica 给你的提示

装插件时 Spica 会校验，出问题会列出「哪个文件 · 哪个字段 · 怎么改」，例如：

| 看到 | 怎么改 |
|---|---|
| `manifest.json · version：版本号「1.0」不合格` | 写三段数字 `1.0.0` |
| `name 只能用小写字母、数字和 -` | 改插件名（还没发布时才改） |
| `entry 要写插件文件夹里的相对路径` | 不用绝对路径、`..` |
| `不能用 .cmd / .bat …启动` | 用 `runtime: node` 跑 `.js`，或自带 `.exe` |
| `这一版只支持自带可执行文件`（Python） | 用 PyInstaller 打成 `.exe`，`runtime: binary` |
| `声明了邮件来源，但插件里没有 MCP server` | 加 `mcp/<id>.json` |
| `插件不兼容这个版本的 Spica` | 改 `compatibility.spica` 或升级 Spica |
| `新版本 X 启动失败，已退回 Y` | 看插件日志里 server 的 stderr；先用 `check.mjs` 在模拟模式下启动 |
| `进程 X 在 60 秒内崩溃了 N 次，已停止重启` | server 有未处理的异常；看插件日志 |
| `下载的文件和来源公布的校验和对不上` | 重新打包、重新生成 `.sha256` / `index.json` |

页面调工具（`window.spica.callTool`）失败时，`content` 以这些码开头：

| 码 | 意思 |
|---|---|
| `PLUGIN_DISABLED` | 插件没启用 |
| `VIEW_NOT_FOUND` | 没有这个页面 |
| `TOOL_NOT_FOUND` | 插件现在没有这个工具（server 可能没起来） |
| `TOOL_NOT_ALLOWED` | 页面的 `permissions.tools` 没列这个工具 |
| `CONFIRM_REQUIRED` | 不可逆工具，用户在确认框里没同意 |
| `UNSUPPORTED` | Spica 版本太旧 |
