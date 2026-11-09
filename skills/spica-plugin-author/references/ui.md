# 带界面的插件

详见 Spica 仓库 `docs/plugins/authoring.md` 第 5b 节、`docs/design/plugins.md` 第 2 节「视图」。完整例子：`plugins/example-notes` 的 `views/notebook.json`（sidebar）和 `views/quick-note.json`（panel），页面在 `ui/`；脚手架 `--with-ui [--placement panel]` 生成的模板。

## 声明 `views/<id>.json`

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 侧栏 / 面板上的名字 |
| `entry` | 是 | 插件目录里的 `.html` 相对路径 |
| `placement` | 否 | `sidebar`（默认）：侧栏里一个入口，点开占主区域，适合完整的功能页；`panel`：对话旁边右栏的一个标签，适合边聊边用的小工具，按 320px 宽设计 |
| `icon` | 否 | 插件目录里的 `.svg` |
| `permissions.tools` | 否 | 页面能调的工具（原名）；不写 = 本插件全部工具 |

文件名就是页面 id：小写字母、数字、`-`。

## `window.spica`

| 成员 | 作用 |
|---|---|
| `callTool(工具, 参数)` | → `Promise<{ content, data?, isError }>`；结果是 JSON 时 `data` 是解析好的对象；失败时 `content` 以错误码开头（见 `errors.md`） |
| `onEvent(fn)` | 收 `{ type: 'theme' }`、`{ type: 'plugin.changed' }`；返回取消函数 |
| `theme` | `{ mode: 'light' \| 'dark' }` |
| `openFile(路径)` | 在 Spica 右栏预览文件（只限本插件目录里的，或这次会话里见过的） |
| `notify(文字, { kind })` | 弹一条提示，`kind`：`info` / `error` |

页面在 Spica 外面打开时没有 `window.spica`，模板会显示一句「要在 Spica 里打开」。

## 主题

只用这 9 个变量，换明暗或皮肤时 Spica 会重新注入：

`--spica-bg`、`--spica-surface`、`--spica-fg`、`--spica-muted`、`--spica-border`、`--spica-accent`、`--spica-danger`、`--spica-font`、`--spica-radius`

主按钮的文字用 `var(--spica-bg)`，在亮色、暗色下都看得清。

## 沙箱

- 没有 Node：不能 `require`、读写文件、起进程。要做这些，在 server 里写工具，页面调工具。
- 只能加载本插件目录里的文件（协议 `spica-plugin://<插件>/<路径>`，CSP 只放它自己，样式允许内联）：不能用 CDN、不能访问网络接口。
- 只能调本插件的工具，而且只能调 `permissions.tools` 列出的。
- 不可逆工具会先弹 Spica 的确认框（「<插件名> 要执行 <工具>，确认吗？」）。
- 插件停用时页面会被关掉。

## 只给页面用的工具

放进 `services/<id>.json` 的 server：工具不给模型，只给自己的页面调。适合做界面专用的查询、统计。

## 预览

```
node <skill>/scripts/preview.mjs <插件文件夹> [--view <id>] [--port 4700] [--real]
```

在浏览器打开它打印的地址（暗色加 `?theme=dark`）。它在模拟模式下启动插件自己的 server，按 Spica 的规则放行工具调用，不可逆工具用浏览器的确认框代替。`--real` 关掉模拟模式。
