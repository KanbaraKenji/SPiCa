# 连上 Spica 装插件

`install.mjs` 经 Spica 自己的 MCP 服务装插件：`spica_plugin_install`（装并启用）、`spica_plugins_list`、`spica_list_tools`、`spica_run`（让 Agent 试用）、`spica_plugin_disable`。有两种连法。

## HTTP + 令牌（连正在运行的 Spica）

```
node <skill>/scripts/install.mjs <zip> --http http://127.0.0.1:<端口>/mcp --token-file <令牌文件>
```

- 令牌从 `--token-file` 读，或设环境变量 `SPICA_MCP_TOKEN`。不要把令牌写在命令行、代码或日志里。
- Spica 默认只听本机（127.0.0.1）。从别的电脑连要对方显式开远程，而且明文，只在可信网络里用。
- **路径是 Spica 那台电脑上的路径**：`spica_plugin_install` 读的是 Spica 所在电脑的文件。同一台电脑没问题；从别的电脑装，要先把 zip 放到两边都能访问的共享文件夹，再传共享路径。
- 端口和令牌文件从哪来：用独立服务时，看下面「从源码起服务」。桌面版 Spica 要在后台配置里开 HTTP MCP 服务（`mcpHttp`）后才有；桌面版还没有这个开关时，用下面的「备用办法」。

## stdio（从源码起一个 Spica 服务）

```
node <skill>/scripts/install.mjs <zip> --stdio <backend.json> --spica <Spica 源码文件夹>
```

脚本会用当前的 Node 启动 `<源码>/packages/core/src/host/mcp-main.ts --config <backend.json>`（源码文件夹要先 `npm install`）。`backend.json` 例子：

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
- `dbPath` 和插件 `root` 用自己的开发文件夹，**不要**指向桌面版正在用的数据文件夹（桌面版开着时数据库被锁，服务会拒绝启动）。
- 从源码起的服务也能开 HTTP：`node packages/core/src/host/mcp-main.ts --config backend.json --http --port 4710 --token-file D:/spica-dev/token.txt`，然后用上面的 HTTP 连法。

## 备用办法：在桌面版里手动装

1. `check.mjs` 打出 zip。
2. 打开 Spica 的 **设置 › 插件**，把 zip 的完整路径粘进安装框，点 **安装**。
3. 打开它的开关；在输入框里让 Agent 用一次新工具；再关掉开关，确认工具消失。

## 常见问题

| 看到 | 原因和办法 |
|---|---|
| `令牌不对（401）` | 令牌文件过期或拿错了，重新读一次 |
| `Spica 拒绝了这个请求（403）` | 只听本机时从别的电脑连了 |
| `连不上 …` | Spica 没开、端口不对，或 HTTP 服务没开 |
| `没有插件命令（spica_plugin_install）` | 后台配置没挂 `@spica/plugins` |
| `找不到 …mcp-main.ts` | `--spica` 没指向 Spica 源码文件夹 |
| `Agent 调了：（没调工具）` | 改工具的 `description`，写清什么时候用；或 `--run` 的话说得更直接 |
