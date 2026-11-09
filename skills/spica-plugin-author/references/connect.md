# 连上 Spica 装插件

`install.mjs` 经 Spica 自己的 MCP 服务装插件：`spica_plugin_install`（装并启用）、`spica_list_tools`、`spica_run`（让 Agent 试用）、`spica_plugin_disable`。按场景选一种。

## 一、装进正在运行的桌面版 Spica（平时用这个）

1. 在 Spica 的 **设置 › 常规 › 开发者** 里打开「允许本机脚本连接 Spica」。打开后 Spica 会写 `<用户文件夹>/mcp-http.json`，Windows 上是 `%APPDATA%\Spica\mcp-http.json`，里面是地址和令牌文件的位置；关掉开关或退出 Spica 时删掉。
2. 直接跑，不用带连接参数：
   ```
   node <skill>/scripts/install.mjs dist/<名字>-<版本>.zip --run "一句会用到新工具的话" --disable-after
   ```
   脚本自己读 `mcp-http.json` 和令牌文件。Spica 装在别的用户文件夹时，加 `--user-data <文件夹>`，或设环境变量 `SPICA_USER_DATA`。
3. 看到「没找到正在运行、而且开了本机连接的 Spica」：Spica 没开，或者这个开关没打开。打开就行，或者用第二种办法。

## 二、开关没开：在设置里手动装

1. `check.mjs` 打出 zip。
2. 打开 Spica 的 **设置 › 插件**，把 zip 的完整路径粘进安装框，点 **安装**。
3. 打开它的开关；在输入框里让 Agent 用一次新工具；再关掉开关，确认工具消失。

## 三、开发时：连自己起的服务

**HTTP + 令牌**：

```
node <skill>/scripts/install.mjs <zip> --http http://127.0.0.1:<端口>/mcp --token-file <令牌文件>
```

令牌从 `--token-file` 读，或设环境变量 `SPICA_MCP_TOKEN`。不要把令牌写在命令行、代码或日志里。

**stdio**（从源码起一个 Spica 服务，源码文件夹要先 `npm install`）：

```
node <skill>/scripts/install.mjs <zip> --stdio <backend.json> --spica <Spica 源码文件夹>
```

`backend.json` 例子：

```json
{
  "dbPath": "D:/spica-dev/spica.db",
  "providers": [{ "id": "main", "kind": "openai-compatible", "baseUrl": "https://<模型网关>/v1", "apiKeyEnv": "SPICA_OPENAI_API_KEY" }],
  "defaults": { "providerId": "main", "model": "<模型名>", "maxTokens": 1000, "maxTurns": 6 },
  "cwd": "D:/spica-dev",
  "extensions": [{ "module": "@spica/plugins", "options": { "root": "D:/spica-dev/plugins", "mock": true } }]
}
```

- key 写成 `apiKeyEnv`（环境变量名），不要把 key 写进文件。
- `extensions` 里必须有 `@spica/plugins`，否则没有插件命令。
- `dbPath` 和插件 `root` 用自己的开发文件夹，**不要**指向桌面版的数据文件夹（桌面版开着时数据库被锁，服务会拒绝启动）。
- 想用 HTTP 连这个服务：`node packages/core/src/host/mcp-main.ts --config backend.json --http --port 4710 --token-file D:/spica-dev/token.txt`。

## 注意

- Spica 只听本机（127.0.0.1）。`spica_plugin_install` 读的是 Spica 所在电脑上的路径。
- 令牌等于能让 Spica 跑命令、读写文件、花模型的钱：别发给别人，别提交进仓库。

## 常见问题

| 看到 | 原因和办法 |
|---|---|
| `没找到正在运行、而且开了本机连接的 Spica` | 打开 Spica，在 设置 › 常规 › 开发者 打开「允许本机脚本连接 Spica」；或用「二、手动装」 |
| `Spica 上次开过本机连接，但现在没在运行` | 先打开 Spica |
| `令牌不对（401）` | 令牌换过了：重开一次开关，或重新读令牌文件 |
| `Spica 拒绝了这个请求（403）` | 只能从本机连 |
| `连不上 …` | Spica 正在重启，稍后再试；或端口不对 |
| `没有插件命令（spica_plugin_install）` | 后台配置没挂 `@spica/plugins` |
| `找不到 …mcp-main.ts` | `--spica` 没指向 Spica 源码文件夹 |
| `Agent 调了：（没调工具）` | 改工具的 `description`，写清什么时候用；或 `--run` 的话说得更直接 |
