# Spica 品牌成品文件

所有文件由 `npm run brand:build -w @spica/brand` 生成，同一套写在两处：

- `apps/desktop/resources/branding/`：应用打包时用
- `branding/`：品牌目录里的副本

SVG 是真矢量（可编辑路径），全部由 `packages/brand/src/` 的构造器导出；PNG 和 ICO 由 SVG 栅格化。

## 应用会用到的

| 文件 | 用途 |
|---|---|
| `spica.ico` | 写死颜色的多尺寸图标，13 帧（16、20、24、28、30、32、36、40、42、48、64、128、256，100%～200% 缩放用到的边长都有，Windows 不用再缩）：安装程序、资源管理器里的 exe、卸载条目；两色花（长瓣 `#39C5BB`，短瓣和花心 `#0F172A`）、透明底、光学版几何，见 `docs/taskbar_icon.md` 第 4 节 |
| `png/spica-taskbar-16.png` ～ `spica-taskbar-256.png` | 运行时任务栏图标的逐帧蒙版：白花、透明底，每个尺寸直接出图、花心对齐像素格（16、20、24、28、30、32、36、40、42、48、64、256）。外壳按任务栏深浅上色后拼成 ico，不从大图缩 |
| `png/spica-win-dark.png` / `spica-win-light.png` | 运行态窗口图标（任务栏、Alt-Tab）的首帧兜底：无底、光学版，深色 / 浅色任务栏各一。应用启动后可由渲染层按当前皮肤现画、交给主进程替换 |
| `png/spica-icon-256.png` | 写死颜色的应用图标（两色花、透明底），找不到其他图标时的兜底 |
| `png/spica-icon-64.png` | 网页预览时的页签图标 |

应用内的所有标志（左上角横标、开机画面、状态动效）都是 React 组件现画的 SVG，不用位图。

## 矢量成品 `svg/`

| 文件 | 内容 |
|---|---|
| `spica-icon.svg` | 写死颜色的应用图标：两色花、透明底、光学版几何（按 256px 对齐像素） |
| `spica-mark-dark.svg` / `spica-mark-light.svg` | 无底花标，暗底 / 亮底用色 |
| `spica-taskbar-dark.svg` / `spica-taskbar-light.svg` | 无底任务栏图标（光学版），深色 / 浅色任务栏用 |
| `spica-wordmark-dark.svg` / `spica-wordmark-light.svg` | 字标 |
| `spica-banner-dark.svg` / `spica-banner-light.svg` | 横标（花标 + 字标），透明底 |

## 位图成品 `png/`

| 文件 | 内容 |
|---|---|
| `spica-icon-16.png` ～ `spica-icon-1024.png` | 写死颜色的应用图标各尺寸：16、24、32、48、64、128、256、512、1024；每个尺寸单独画，不从大图缩 |
| `spica-win-dark.png` / `spica-win-light.png` | 无底窗口图标，256px |
| `spica-banner-dark.png` / `spica-banner-light.png` | 横标位图，256px 高，带底色，宣传和文档用 |

## 字体 `fonts/`

| 文件 | 内容 |
|---|---|
| `Gelasio-Bold.ttf` | 字标用的开源字体（SIL OFL 1.1），上游原文件 |
| `OFL.txt` | 字体许可证全文 |

字标已转成路径写在 `packages/brand/src/wordmark.ts`，应用运行时不读字体文件；字体文件只用于重新生成字标。

## 素材 `icons/`

完成图标是原样收进来的素材，不由脚本生成，也不要改；同一族另外八个由 `brand:build` 生成。画法和用途见 `docs/status_icons.md`。

| 文件 | 内容 |
|---|---|
| `spica-check.svg` | 完成状态图标（带圈对钩），单色、颜色随调用处；要求见 `docs/check_icon.md`。应用里用 `@spica/brand/react` 的 `SpicaStatusIcon name="done"`，图形和本文件逐字一致（有测试核对） |
| `spica-check-preview.svg` | 同一个对钩填了绿色的预览版，只用来看效果，不要直接引用 |
| `spica-running.svg`、`spica-warning.svg`、`spica-error.svg`、`spica-waiting.svg`、`spica-question.svg`、`spica-stopped.svg`、`spica-queued.svg`、`spica-info.svg` | 同一族的另外八个状态图标（进行中、警告、错误、等待确认、提问、已停止、排队、提示），单色、currentColor；脚本生成，和 `SpicaStatusIcon` 同一份代码 |

## 生成脚本

| 文件 | 作用 |
|---|---|
| `packages/brand/scripts/build.ts` | `brand:build` 入口：出 SVG、栅格化、打 ICO、写两处目录 |
| `packages/brand/scripts/ico.ts` | PNG-in-ICO 打包 |
| `packages/brand/scripts/wordmark-from-font.ts` | 把字体里的 Spica 转成路径，重写 `src/wordmark.ts` |
