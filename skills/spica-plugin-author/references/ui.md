# 带界面的插件

详见 Spica 仓库 `docs/plugins/authoring.md` 第 5b 节、`docs/design/plugins.md` 第 2 节「视图」。完整例子：`plugins/example-notes` 的 `views/notebook.json`（sidebar）、`views/quick-note.json`（panel）和 `views/settings.json`（settings），页面在 `ui/`；脚手架 `--with-ui [--placement panel|settings]` 生成的模板。

## 声明 `views/<id>.json`

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 侧栏 / 面板上的名字 |
| `entry` | 是 | 插件目录里的 `.html` 相对路径 |
| `placement` | 否 | `sidebar`（默认）：侧栏里一个入口，点开占主区域，适合完整的功能页；`panel`：窗口最右「详情」那一栏顶上的一个标签，适合边聊边用的小工具，这一栏固定 300px 宽（不能拖宽、不能盖住对话），按 300px 宽设计；`preview`：给某几种文件当预览，见下面「预览页」；`settings`：插件自己的设置页，见下面「设置页」 |
| `icon` | 否 | 插件目录里的 `.svg` |
| `permissions.tools` | 否 | 页面能调的工具（原名）；不写 = 本插件全部工具（预览页不写 = 一个都不能调） |
| `preview` | placement 为 preview 时必填 | `{ "extensions": [".docx", ".docm"], "max_mb": 30 }`：能预览的扩展名（小写、带点；不能有 .pdf 和图片，这些 Spica 自己预览）；能处理的最大文件，1 到 100，不写是 20 |

文件名就是页面 id：小写字母、数字、`-`。

## `window.spica`

| 成员 | 作用 |
|---|---|
| `callTool(工具, 参数)` | → `Promise<{ content, data?, isError }>`；结果是 JSON 时 `data` 是解析好的对象；失败时 `content` 以错误码开头（见 `errors.md`） |
| `onEvent(fn)` | 收 `{ type: 'theme' }`、`{ type: 'plugin.changed' }`；返回取消函数 |
| `theme` | `{ mode: 'light' \| 'dark' }` |
| `openFile(路径)` | 在 Spica 的预览栏打开文件（只限本插件目录里的，或这次会话里见过的） |
| `notify(文字, { kind })` | 弹一条提示，`kind`：`info` / `error` |
| `pickFolder({ title?, defaultPath? })` | 弹系统的选文件夹框 → `Promise<完整路径 \| null>`，`null` 是用户取消了 |
| `pickFile({ title?, defaultPath?, extensions? })` | 弹系统的选文件框（选一个）→ `Promise<完整路径 \| null>`；`extensions` 如 `[".md", ".txt"]`，不写 = 任何文件 |
| `openFolder(路径)` | 在系统的资源管理器里打开文件夹 → `Promise<null>`，打不开时 reject（`err.message` 说原因）；只认本机盘符开头的文件夹 |

页面在 Spica 外面打开时没有 `window.spica`，模板会显示一句「要在 Spica 里打开」。

## 主题

只用这些变量，换明暗或皮肤时 Spica 会重新注入：

`--spica-bg`、`--spica-surface`、`--spica-fg`、`--spica-muted`、`--spica-border`、`--spica-accent`、`--spica-danger`、`--spica-font`、`--spica-radius`

按钮和输入框照 Spica 自己的做：

| 变量 | 用在 |
|---|---|
| `--spica-control` / `--spica-control-hover` | 按钮底色 / 悬停 |
| `--spica-input` | 输入框底色 |
| `--spica-border-strong` | 按钮和输入框的边 |
| `--spica-placeholder` | 输入框里的灰色提示字 |
| `--spica-on-accent` | 主按钮（底色 `--spica-accent`）上的字 |
| `--spica-control-h` | 按钮、输入框、图标按钮的高度（现在 28px） |

标签和输入框里的字用 `--spica-fg`；灰字 `--spica-muted` 只给说明和状态。不要写死颜色。

## 沙箱

- 没有 Node：不能 `require`、读写文件、起进程。要做这些，在 server 里写工具，页面调工具。
- 只能加载本插件目录里的文件（协议 `spica-plugin://<插件>/<路径>`，CSP 只放它自己，样式允许内联）：不能用 CDN、不能访问网络接口。
- 只能调本插件的工具，而且只能调 `permissions.tools` 列出的。
- 不可逆工具会先弹 Spica 的确认框（「<插件名> 要执行 <工具>，确认吗？」）。
- 插件停用时页面会被关掉。

## 只给页面用的工具

放进 `services/<id>.json` 的 server：工具不给模型，只给自己的页面调。适合做界面专用的查询、统计。

## 设置页（placement: settings）

插件要用户填的东西（服务地址、令牌、导出到哪个文件夹）放在这里：页面显示在 设置 › 插件 › 这个插件的详情里：名字和「更新 / 删除」那两行下面多一行页签，第一个是「详情」，后面每个设置页一个，页签文字是 `title`。点它，下面整块换成这个页面，占满右栏剩下的高度；侧栏不多出入口。插件停用时不显示。第一次点到页签才加载，切回「详情」再回来，填了一半的东西还在。

```json
{ "title": "设定", "entry": "ui/settings.html", "placement": "settings", "permissions": { "tools": ["get_settings", "save_settings"] } }
```

- 可以有几个设置页，各占一个页签。规则和别的页面一样：沙箱、只能调本插件的工具、`permissions.tools` 生效。
- 页面自己滚：内容比右栏高时，页面里出滚动条，外面的右栏不滚。
- 背景：设置页里 `--spica-bg` 是设置窗口右边那一栏的底色（页面和它连成一片）；按钮用 `--spica-control`、输入框用 `--spica-input`。
- 读写设置的工具放进 `services/`（只给页面用，模型看不到），存进 `SPICA_PLUGIN_DATA/config.json`，见 `internal-services.md`。

选文件夹：输入框后面两个方形图标按钮，图标和 Spica 自己 设置 › 常规 › 工作流 那一行的一样：紧挨输入框的铅笔 =「选择文件夹」，后面的文件夹图标 =「打开文件夹」，名字写进 `title`（悬停显示）。图标用内嵌 SVG，样式 `button.icon` 照抄 `plugins/example-notes/ui/style.css`。

```html
<div class="field-row">
  <input id="folder" type="text">
  <button type="button" class="icon" id="pick" title="选择文件夹" aria-label="选择文件夹">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9z"/></svg>
  </button>
  <button type="button" class="icon" id="open" title="打开文件夹" aria-label="打开文件夹" disabled>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z"/></svg>
  </button>
</div>
```

```js
pick.onclick = async () => {
  const dir = await window.spica.pickFolder({ title: '选择导出文件夹', defaultPath: box.value || undefined });
  if (dir === null) return;        // 用户取消：什么都不改
  box.value = dir;                 // 填回页面，用户点「保存」时经自己的工具存
};
open.onclick = () => window.spica.openFolder(box.value).catch((err) => showError(err.message));
box.oninput = () => (open.disabled = !box.value.trim());   // 框里空着时「打开」不能点
```

- 只给路径。读写还是插件自己的工具（钩子和确认照常生效）。
- 对话框挂在 Spica 窗口上，标题前面加插件名（「Notes (example) · 选择导出文件夹」）；同一时间只开一个，第二个请求直接得到 `null`。
- `defaultPath` 只认本机盘符开头的完整路径（`D:\…`），网络路径（`\\server\share`）会被忽略。
- 不用在清单里声明；预览页不能用（它拿着用户的文件）。sidebar、panel 的页面也能用。
- `openFolder` 只在资源管理器里打开，不读、不执行：网络路径直接报错；是文件或不存在时报「找不到文件夹：…」。

## 预览页（placement: preview）

给某几种文件当「预览」：用户在 设置 里选了用它预览这种文件后，对话右边的预览栏打开这种文件时就显示这个页面（可以拖宽、可以盖住对话），Spica 把**这一个文件**交给它。

```json
{ "title": "Word 原样预览", "entry": "ui/docx.html", "placement": "preview", "preview": { "extensions": [".docx", ".docm"], "max_mb": 30 } }
```

- 页面拿到的是文件名、大小、修改时间、扩展名和文件内容（字节），没有完整路径；读不了别的文件，也写不回去，照样不能联网。
- 文件比 `max_mb` 大、页面 15 秒没说画好、页面说画不了或者出错，Spica 都改用自带的预览。
- 不写 `permissions.tools` 就不能调本插件的工具（它拿着用户的文件）。
- 预览页用的桥接口（`spica.preview.*`）由 Spica 的界面提供，写法见 Spica 仓库作者指南 5b 节；完整例子是 Spica 仓库的 `plugins/office-preview`。

## 预览

```
node <skill>/scripts/preview.mjs <插件文件夹> [--view <id>] [--port 4700] [--real] [--pick <完整路径>]
```

在浏览器打开它打印的地址（暗色加 `?theme=dark`）。它在模拟模式下启动插件自己的 server，按 Spica 的规则放行工具调用，不可逆工具用浏览器的确认框代替。`--real` 关掉模拟模式。

- 选文件夹 / 选文件（`pickFolder` / `pickFile`）：带 `--pick D:\Notes` 时直接回这个路径，当作用户选了它，什么都不弹，脚本自动点页面时用这个。不带时用浏览器的输入框问你；自动化里输入框弹不出来，或者被关掉，就回 `null`，也就是「用户取消」。所以测取消，不带 `--pick` 再点一次就行。
- 每次调用在页面的控制台打一行：`[preview] pickFolder {"title":"选择笔记文件夹"} -> D:\Notes`（取消时是 `-> null`）。
- `openFolder` 只在控制台打一行，不开资源管理器。
