# 文档索引

Spica 的设计文档用中文，README、代码注释和提交信息用英文。改一个模块之前，先读它的设计文档；每份文档末尾都有「交接」或「故意没做」一节，写着做到哪一步。

## 总览

- [架构图](architecture.svg)：桌面应用的三个进程、各个包、插件、模型和外部 MCP 客户端之间的关系（英文 README 里也有）。
- [repo-layout.md](design/repo-layout.md)：仓库布局与全仓约定：目录、工具链选择的理由、怎么加新包、不弹控制台、按用户安装、敏感词扫描。

## 设计文档（`design/`）

| 文档 | 一句话 |
|---|---|
| [agent-core.md](design/agent-core.md) | Agent 内核：主循环、上下文怎么组装、钩子、内置工具、三层团队与回传、插话、花费与可追溯记录、后端进程与本程序的 MCP 服务、邮件流水线 |
| [desktop-shell.md](design/desktop-shell.md) | 桌面外壳：三栏布局、进程与 IPC、事件到界面的映射、皮肤和缩放、收件箱、打包更新与公告、截图脚本 |
| [ui-rules.md](design/ui-rules.md) | 界面规范：文字、颜色、大小和字号、对齐、控件的样子，每条落在哪个变量或组件、哪条测试在拦；改界面之前先读 |
| [file-extract.md](design/file-extract.md) | 文件读取：PDF、Word、Excel、PowerPoint、CSV 怎么转成模型能读的文字，分块规则和文件卡片 |
| [plugins.md](design/plugins.md) | 插件系统：插件文件夹格式、扩展点、启用停用全撤销、MCP server 进程、模拟模式、分发与更新 |
| [outlook-mail.md](design/outlook-mail.md) | 官方 Outlook 邮件插件：工具表、错误码、怎么调本机经典版 Outlook、模拟模式、安全边界 |

## 给插件作者

- [plugins/authoring.md](plugins/authoring.md)：从零写一个插件：清单、MCP server、技能、命令、钩子、模拟数据、本地试、打包发布。可运行的例子在仓库的 `plugins/example-notes`。

## 品牌

- `branding/docs/`：标志的几何、颜色、状态动效、成品文件和重新生成方法（[README](../branding/docs/README.md)、[animation.md](../branding/docs/animation.md)、[files.md](../branding/docs/files.md)）。

## 截图

- `screenshots/shell/`：J8 截图矩阵（对话页、设置页 × 明暗 × 四种窗口尺寸 × 100% / 150% 缩放），由 `npm run shots` 生成。
- `screenshots/brand/`：开机动画和字标的定稿版与关键静帧。
- `screenshots/skeleton*.png`：仓库骨架阶段的第一张窗口截图，留作对照。

## 验收

八条首版验收旅程怎么跑，见英文 README 的「Acceptance journeys」一节；一次全跑：`npm run acceptance`，汇总存到 `out/acceptance/`（不进仓库）。
