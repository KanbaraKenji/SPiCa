# 让用户填的设置：`user_config`

在 `manifest.json` 里声明要用户填的项，Spica 替你画表单、替你存（密码加密存），启动 server 时把值交给它。你不用写设置页，也不用自己存文件。

新插件直接生成：`scaffold.mjs <名字> --with config`，得到下面三项的声明、`server/config.js`、`mock/user-config.json`（自查、预览、测试时用的假值）、一个用到它的工具 `check_settings` 和一条测试。

## 完整例子（照抄改名字）

`manifest.json` 里加：

```json
"user_config": {
  "server_url": { "type": "url", "title": "服务器地址", "placeholder": "https://tickets.example.com", "required": true },
  "password":   { "type": "password", "title": "密码", "required": true },
  "mode":       { "type": "select", "title": "汇总方式", "options": ["日报", "周报"], "default": "日报" }
}
```

server 里读（Node）：

```js
// server/config.js
import { readFileSync } from 'node:fs';
let cached;
/** The values the user filled in (Settings › Plugins › this plugin), by key; null when not filled in. */
export function readConfig() {
  if (cached) return cached;
  const raw = process.env.SPICA_USER_CONFIG;
  // outside Spica (check.mjs, preview, node --test) the made-up values in mock/user-config.json stand in
  cached = raw ? JSON.parse(raw) : JSON.parse(readFileSync(new URL('../mock/user-config.json', import.meta.url), 'utf8'));
  // read once, then out of the environment: processes this server starts do not inherit the password
  delete process.env.SPICA_USER_CONFIG;
  return cached;
}
```

```js
import { readConfig } from './config.js';
const { server_url, password, mode } = readConfig();
if (!server_url || !password) return { text: '[NOT_CONFIGURED] 还没填服务器地址或密码：设置 › 插件 › 这个插件。', isError: true };
```

用户在 设置 › 插件 › 这个插件 › 详情 里看到「设置」一组：服务器地址、密码、汇总方式三行和一个「保存」。

## 类型

| `type` | 表单上是 | server 拿到 |
|---|---|---|
| `text` | 一行文字 | 字符串 |
| `password` | 密码框（存进去以后再也显示不出来） | 字符串 |
| `url` | 网址；没写 `https://` 时 Spica 补上，只认 http / https | 字符串 |
| `number` | 数字，可带 `min` / `max` | 数字 |
| `toggle` | 开关 | `true` / `false` |
| `select` | 下拉，选项在 `options`（文字列表） | 选中的那一项 |
| `folder` | 选文件夹 | 完整路径 |
| `file` | 选文件 | 完整路径 |

每项还能写：`title`（必填，表单上的名字）、`placeholder`（框里的灰字例子）、`required`（`true` = 必填）、`default`（没填时用它；密码不能有默认值）。

## 规矩

- 键名小写字母开头，只用小写字母、数字、下划线，例如 `server_url`。server 拿到的 JSON 里键名就是这个，不变形。
- `SPICA_USER_CONFIG` 里**每个声明过的键都有**：填了是填的值，没填有默认值是默认值，都没有是 `null`。
- 必填项没填齐时，插件算「已启用」但**什么都不跑**（server 不起，技能、命令、钩子不挂），列表和详情里写「N 项未填」。填齐保存后自动起来。
- 用户改了值并保存，这个插件的 server 重启一次，读到新值。
- 密码：Spica 用 Windows 的用户密钥加密存，界面上只显示「已保存」；插件日志里出现它会被换成 `[redacted]`（很短的密码只在前后不是字母数字时换得掉）。`readConfig()` 读完把变量删掉；你不用它、自己读 `process.env.SPICA_USER_CONFIG` 也可以，但你起的辅助进程会继承这个变量，要自己清。
- 环境变量有长度上限，设置项放地址、账号、开关这类短内容，不放大段文字。
- 公司打包时可以在 `deploy.json` 里替所有人预填某几项，或锁定（界面上名称旁有一把锁，悬停显示「由管理员设置」，改不了）。密码不能预填。
- 标签写清是什么：占位符一打字就没了，所以关键信息写进 `title` 本身，比如「账号（工号）」「服务器地址」。
- 别的语言的标题、说明、占位符写在清单 `i18n` 里：`"i18n": { "en": { "user_config": { "server_url": { "title": "Server URL" } } } }`（见 `manifest.md`）。报错（「请输入数字」之类）由 Spica 按界面语言显示，不用翻。

## 用表单还是自己画设置页

每一项对一下上面的类型表：对得上的写进 `user_config`；对不上的（「测试连接」按钮、能增删的列表、选了 A 才出现 B 的联动）才放进自己画的设置页（`views/<id>.json` 的 `placement: "settings"`，见 `ui.md`）。同一项只放一处。两种可以并存：表单在「详情」里，自己的页面是后面的页签，页签别再叫「设置」。

## `check.mjs` 查什么

- 清单里的 `user_config`：规则和 Spica 装插件时一样（见下面「报错长什么样」）。
- 代码里读了清单没声明的键（`readConfig().serverUrl`、`config.serverUrl`、`const { serverUrl } = readConfig()`），提醒你是哪个文件哪一行、声明过的有哪些。键名就是清单里写的，不变形。
- 启动 server 时，它拿 `mock/user-config.json` 的值当设置，每个 password 项换成一个记号值；server 的输出里出现这个记号，说明密码被写进了日志，会提醒你。

这几条都是提醒，不拦你打包。

## 报错长什么样

装插件或跑 `check.mjs` 时，写错的地方会指到字段，并列出能写的：

- `manifest.json · user_config.password.type：没有 "secret" 这种类型，可以写 text、password、number、toggle、select、folder、file、url；密码写 password。`
- `manifest.json · user_config.mode.options：select 要写 options，例如 ["日报", "周报"]。`

从 Claude Desktop 的 MCPB 包搬过来的清单（`string` + `sensitive: true`、`boolean`、`directory`）照样能装，Spica 按这里的写法读，并提示一句怎么改写。
