# Spica 品牌成品文件

所有文件由 `npm run brand:build -w @spica/brand` 生成，同一套写在两处：

- `apps/desktop/resources/branding/`：应用打包时用
- `branding/`：品牌目录里的副本

SVG 是真矢量（可编辑路径），全部由 `packages/brand/src/` 的构造器导出；PNG 和 ICO 由 SVG 栅格化。

## 应用会用到的

| 文件 | 用途 |
|---|---|
| `spica.ico` | Windows 快捷方式、安装包、资源管理器用的多尺寸图标，内含 16～256px 磁贴版 |
| `png/spica-win-dark.png` / `spica-win-light.png` | 运行态窗口图标（任务栏、Alt-Tab）的首帧兜底：无底、光学版，深色 / 浅色任务栏各一。应用启动后可由渲染层按当前皮肤现画、交给主进程替换 |
| `png/spica-icon-256.png` | 带磁贴底的桌面图标，找不到其他图标时的兜底 |
| `png/spica-icon-64.png` | 网页预览时的页签图标 |

应用内的所有标志（左上角横标、开机画面、状态动效）都是 React 组件现画的 SVG，不用位图。

## 矢量成品 `svg/`

| 文件 | 内容 |
|---|---|
| `spica-icon.svg` | 桌面图标：深色圆角磁贴 + 暗色版的花 |
| `spica-mark-dark.svg` / `spica-mark-light.svg` | 无底花标，暗底 / 亮底用色 |
| `spica-taskbar-dark.svg` / `spica-taskbar-light.svg` | 无底任务栏图标（光学版），深色 / 浅色任务栏用 |
| `spica-wordmark-dark.svg` / `spica-wordmark-light.svg` | 字标 |
| `spica-banner-dark.svg` / `spica-banner-light.svg` | 横标（花标 + 字标），透明底 |

## 位图成品 `png/`

| 文件 | 内容 |
|---|---|
| `spica-icon-16.png` ～ `spica-icon-1024.png` | 磁贴版各尺寸：16、24、32、48、64、128、256、512、1024 |
| `spica-win-dark.png` / `spica-win-light.png` | 无底窗口图标，256px |
| `spica-banner-dark.png` / `spica-banner-light.png` | 横标位图，256px 高，带底色，宣传和文档用 |

## 字体 `fonts/`

| 文件 | 内容 |
|---|---|
| `Gelasio-Bold.ttf` | 字标用的开源字体（SIL OFL 1.1），上游原文件 |
| `OFL.txt` | 字体许可证全文 |

字标已转成路径写在 `packages/brand/src/wordmark.ts`，应用运行时不读字体文件；字体文件只用于重新生成字标。

## 生成脚本

| 文件 | 作用 |
|---|---|
| `packages/brand/scripts/build.ts` | `brand:build` 入口：出 SVG、栅格化、打 ICO、写两处目录 |
| `packages/brand/scripts/ico.ts` | PNG-in-ICO 打包 |
| `packages/brand/scripts/wordmark-from-font.ts` | 把字体里的 Spica 转成路径，重写 `src/wordmark.ts` |
