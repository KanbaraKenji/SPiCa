# 连内部接口

插件通常是在给公司内部的某个服务包一层：工单、库存、报表、审批……这一页说四件事：地址和凭据放哪、证书和代理、工具怎么设计、应用改了名怎么连。

## 一、地址和凭据放哪

**不要写进代码，也不要从环境变量读。** 装进 Spica 后，插件进程只获得一份白名单里的环境变量（`PATH`、`TEMP`、`APPDATA` 这类），名字带 `KEY`、`TOKEN`、`SECRET` 的一律不传。你在开发机上设的 `EXAMPLE_API_TOKEN`，装进去后就读取不到了。`check.mjs` 看到代码读这种变量会提醒你。

真能用的有两种：

| 放什么 | 放哪 | 谁来填 |
|---|---|---|
| 服务地址、账号、令牌、个人偏好 | `SPICA_PLUGIN_DATA` 里的 `config.json`（每个用户本机一份，升级插件不会丢，也不进插件包） | 用户在插件**自己的设置页**里填 |
| 不敏感、所有人都一样的固定值 | `mcp/<id>.json` 的 `env`（会进插件包） | 你，写死在包里 |

Spica 没有统一的「设置 › 插件」表单。插件需要设置时，就在它自己的页面里放一个设置区（或单独一个页面），页面通过 `services/` 里的工具读写 `config.json`：

```
services/settings.json   { "runtime": "node", "entry": "server/settings.js" }
views/settings.json      { "title": "Settings", "entry": "ui/settings.html", "placement": "sidebar",
                           "permissions": { "tools": ["get_settings", "save_settings"] } }
```

`services/` 里的工具只给本插件的页面用，模型看不到，所以「保存令牌」这种事不会被 Agent 误调。写法：

```js
// server/settings.js 里两个工具的实现（MCP 外壳照 server/index.js 写）
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const file = join(process.env.SPICA_PLUGIN_DATA, 'config.json');
const read = () => readFile(file, 'utf8').then(JSON.parse, () => ({}));

export async function getSettings() {
  const c = await read();
  // 密码、令牌不回传给页面，只告诉它填没填
  return { baseUrl: c.baseUrl ?? '', hasToken: Boolean(c.token) };
}

export async function saveSettings({ baseUrl, token }) {
  const c = await read();
  if (typeof baseUrl === 'string') c.baseUrl = baseUrl.trim();
  if (typeof token === 'string' && token) c.token = token;
  await mkdir(process.env.SPICA_PLUGIN_DATA, { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(c, null, 1));
  await rename(`${file}.tmp`, file);
  return { saved: true };
}
```

给模型用的 server（`mcp/`）每次调工具时读同一个 `config.json`。还没填就返回 `[NOT_CONFIGURED] 还没填服务地址，打开插件的设置页填一下。`，不要崩溃。日志和错误文字里不写令牌。

页面的写法（`window.spica.callTool`、主题变量）见 `references/ui.md`；能跑的页面例子在 `plugins/example-notes`（Notebook 和 Quick note）。

## 二、证书和代理：Spica 代管，你不用写

> **版本**：从 Spica 0.1.0-rc.2 起才代管。rc.1 和更早的版本里，插件进程无法获得应用的代理和证书，连公司内网可能报证书错误；这时请用户升级 Spica，不要在插件里绕开证书检查。

公司内网的服务常用公司自己发的证书，出外网还要走代理。Spica 自己连网时，信任的是 Windows 系统证书，加上 **设置 › 常规 › 网络** 里的「信任的证书文件」，代理也按那里的设置走。插件的 server 进程启动时使用同一套设置：

| 给了什么 | 谁用 |
|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（大小写各一份），加 `NODE_USE_ENV_PROXY=1` | Node 的 `fetch`、`https`；多数自带可执行文件也认这几个代理变量 |
| `NODE_EXTRA_CA_CERTS`（系统证书和信任的证书文件里的证书），`NODE_USE_SYSTEM_CA=1` | Node |
| `SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`：一个完整的证书文件（公共根证书 + 系统证书 + 信任的证书文件） | 自带可执行文件：OpenSSL 系、Python requests、curl、Go |

所以：

- **Node 写的 server 直接用 `fetch` 或 `https`**，不用写任何证书、代理代码。
- **不要**写 `rejectUnauthorized: false`、`NODE_TLS_REJECT_UNAUTHORIZED=0`，也不要把证书文件打进插件包，或者自己去读代理设置。连不上时返回 `[SERVICE_UNREACHABLE]`，让用户去查网络设置。
- **自带可执行文件**：Spica 只能把上面这些变量传给它。它认不认，要看它用的库：Python 的 requests 认 `REQUESTS_CA_BUNDLE` 和代理变量；Go 认 `SSL_CERT_FILE` 和代理变量；不认的，要你自己在程序里读这几个变量。
- **用户改了网络设置**：正在运行的插件 server 会自动重启一次。这几秒里它的工具会先消失再回来，之后的请求就按新设置走，用户不用做什么。重启那一刻正在跑的调用会失败，让它重试一次就行。
- 代理要登录时，代理地址里带着账号密码，也会传进插件进程。所以不要把环境变量整个写进日志。
- `check.mjs` 在模拟模式下跑，用的是开发机自己的网络，不是 Spica 的网络设置。要验证真连内网，就装进 Spica 再试。

## 三、工具按用户要办的事设计

不要一个接口做一个工具。模型看到的是工具清单，它要猜「用户这句话该调哪个」。工具越像用户会说的事，越不容易调错：

- 好：`find_order(客户或单号)` 一次返回状态、金额和最近一条进度，背后调了三个接口。
- 不好：`search_orders`、`get_order`、`get_order_status`、`get_order_history` 各一个，模型要自己串。
- 一个插件的工具控制在十个以内。返回只给回答问题要用的字段；长列表分页，给出条数。
- 会改外部系统的（提交、审批、删除）单独做工具，写进 `permissions.irreversible`。
- `description` 写成「用户想 X 时用它」，见 `SKILL.md` 第 3 步。

## 四、应用改了名

公司可以把 Spica 打包成别的名字。改的只是显示的名字，插件这边什么都不用改：工具名前缀、`SPICA_` 环境变量、清单里的 `compatibility.spica`、`window.spica`、`--spica-*` 颜色变量、`.spicaignore` 全都照旧。装插件时用 `install.mjs --app <应用名>`，只开着一个改了名的应用时不加也行，见 `references/connect.md` 第一节第 4 条。
