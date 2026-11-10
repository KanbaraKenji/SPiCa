# Spica 品牌规范

Spica 的标志是一朵九片瓣的花，叫「九芒」。本目录是品牌的说明书：几何、颜色、状态动效、成品文件和重新生成方法。改标志之前先读这里。

- 几何与构造器的源码：`packages/brand/`（包名 `@spica/brand`）
- 应用打包用的成品：`apps/desktop/resources/branding/`
- 本目录的 `svg/`、`png/`、`spica.ico`：同一套成品的副本，方便直接取用

## 标志

- 九片瓣，每片隔 40°；12 / 4 / 8 点钟方向的三片是长瓣，其余六片是短瓣；中心一枚实心的轴。
- 两色：短瓣和轴用文字色（`currentColor`），长瓣用强调色（CSS 变量 `--spica-accent`）。换皮肤标志跟着换；单色皮肤下自然退化成单色。暗底、亮底都成立。
- 横标 = 花标 + 字标 `Spica`。版本号不进横标，只在开机画面里作附注。
- 任何状态下标志轮廓一像素不动：动效只动位置、透明度、整体旋转和缩放，不切割、不变形。

## 几何

全部数字只在 `packages/brand/src/geometry.ts` 里定义，React 组件、开机画面、导出脚本都从这里取，**不许在别处复刻数字**。

| 参数 | 值 |
|---|---|
| 画框 | viewBox `0 0 64 64` |
| 瓣的局部坐标 | 基座 (32, 27) 朝上，绕 (32, 32) 旋转 k × 40° |
| 长瓣 长 × 宽 | 24 × 4.2 |
| 短瓣 长 × 宽 | 16 × 3.4 |
| 轴半径 | 4.5 |
| 整体放大 | 1.15 |
| 整体下移 | 5（花心落在画框的 (32, 37)，视觉居中、顶尖不被切） |

瓣形是两条三次曲线围成的收尖叶形，见 `petalPath()`。单元测试把长短瓣的路径与定稿逐数比对，改动几何会让测试失败。

### 任务栏光学版

任务栏图标只有 24px 左右，原版花的有色像素只占约 23%，比旁边的实心图标显得淡。光学版是同一朵花，只在导出的任务栏 / 窗口图标上放大、加粗，占比提到约 33%；应用内的花不用它。

| 参数 | 原版 | 光学版 |
|---|---|---|
| 整体放大 | 1.15 | 1.22 |
| 整体下移 | 5 | 5.65 |
| 长瓣宽 | 4.2 | 5.6 |
| 短瓣宽 | 3.4 | 4.6 |
| 轴半径 | 4.5 | 5.2 |

参数在 `TASKBAR_PARAMS`；`taskbarSvg()` 用它出图。

## 颜色

定义在 `packages/brand/src/tokens.ts`。应用内不写死颜色，下面的值只给成品图标、横标位图和 CSS 变量缺省时兜底。

| 用途 | 暗色 | 亮色 |
|---|---|---|
| 文字色（短瓣、轴、字标） | `#F1F5F9` | `#0F172A` |
| 强调色（长瓣） | `#62A9FF` | `#2F7DE1` |
| 横标位图底色 | `#0F1522` | `#F8FAFC` |

- 写死的应用图标：长瓣 `#39C5BB`，短瓣和花心 `#0F172A`。
- accent lock：`#39C5BB`（CSS 变量 `--spica-accent-lock`），见 `animation.md` 的「点击」。

## 图标的底

- 任务栏 / 窗口图标：无底，随任务栏明暗换色（深色任务栏用亮花，浅色任务栏用深花）。
- 安装程序、资源管理器里的 exe、卸载条目：图标写死在文件里，不能随任务栏变色，花直接画在透明底上，不加底板、描边、阴影，长瓣 `#39C5BB`、短瓣和花心 `#0F172A`（2026-11-10 定，取代深色圆角磁贴底和「黑边白花」）。详见 `taskbar_icon.md` 第 4 节。

## 字标

字标写作首字母大写的 `Spica`，字形取自开源字体 **Gelasio Bold**（Version 1.008，SorkinType，SIL Open Font License 1.1；和 Georgia 宽度一致、字形相近的开源衬线体）。小写 p 的碗和竖笔实接，没有缺口。

- 字体文件和许可证：`branding/fonts/Gelasio-Bold.ttf`、`branding/fonts/OFL.txt`（上游 https://github.com/SorkinType/Gelasio 原文件，未改动）。
- 运行时不用字体文件：`packages/brand/src/wordmark.ts` 里是转好的路径，每个字母一条，带它的水平中心（开机画面逐字点亮用）。
- 坐标：大写字母高 64 单位，基线在 y = 64，p 的竖笔下伸 21；i 的点和 S 的顶高出大写字母 6（`ascent`），字标画框从 y = -6 起，不再切掉它们。
- 横标里字的大写高是花标框高的 0.5625（花标 64 见方，字大写高 36），在花标框里竖向居中，间距 16。

换字体或调字距：

```powershell
npm run wordmark:from-font -w @spica/brand -- ../../branding/fonts/Gelasio-Bold.ttf   # 可再加字距，单位千分之一字号
npm run brand:build
```

只接受静态字重的 TTF / OTF；可变字体先取出需要的字重。

### 换成别的应用名

公司按自己的名字打包时，不改仓库里的任何文件，另外生成一份字标 JSON：

```powershell
npm run wordmark:from-font -w @spica/brand -- ../../branding/fonts/Gelasio-Bold.ttf --text "应用名" --json 输出路径.json   # 也可以换成公司自己的字体文件
```

- 构建脚本里也可以直接调函数：`import { wordmarkForName } from '@spica/brand/node'`，`wordmarkForName(名字, 字体字节?)` 返回同样的 `Wordmark`；不给字体用自带的 Gelasio，名字是 Spica 时原样返回仓库里的字标。只在构建时（Node）用，不要打进渲染层。
- JSON 就是一个 `Wordmark` 对象，交给 `SpicaSplash`、`SpicaBanner`、`SpicaWordmark` 的 `wordmark` 属性（字符串版是 `bannerSvg` / `wordmarkSvg` 的 `wordmark` 选项）。不传就是仓库自带的 Spica 字标，和原来一样。
- 文字原样使用，大小写不改。空格只占位置，不算一个字母；字体里缺的字会一次全列出来报错。
- 开机画面：花标和字标作为一组水平居中；名字长到整组超过舞台宽的 80% 时，字标按比例缩小，花标大小不变。扫字的光照样从左扫到右。
- 侧栏横标按高度等比缩放，名字越长越宽，放不放得下由使用方决定。
- 看效果：`SPLASH_WORDMARK=输出路径.json node scripts/render-splash-video.mjs dark 112 113 7 10 <目录>` 出一帧开机画面。

## 在应用里使用

```ts
import '@spica/brand/styles.css';
import { SpicaMark, SpicaBanner, SpicaStatusIcon } from '@spica/brand/react';
import { markSvg, taskbarSvg, BRAND_COLORS } from '@spica/brand';

<SpicaMark size={28} state="busy" />          // 状态见 animation.md
<SpicaBanner height={28} tappable />           // 左上角横标，可点击
taskbarSvg({ ink: '#F1F5F9', accent: '#62A9FF' }) // 主进程窗口图标
<SpicaStatusIcon name="done" size={16} />       // 完成状态（带圈对钩），颜色取皮肤的 --spica-success
```

带圈状态图标（完成、警告、错误、进行中这一族）统一线宽 2.5、圆圈半径 9.5，比菜单、按钮这类操作图标粗；所有表示完成的地方都用 `done`，不换成图标库自带的带圈对钩。要求见 `check_icon.md`。

页面上设置 `--spica-accent`（任意 CSS 颜色）即可让长瓣跟随皮肤。

## 重新生成成品

```powershell
npm run brand:build -w @spica/brand
```

`packages/brand/scripts/build.ts` 从几何源出全部 SVG，再用 `@resvg/resvg-js` 栅格化成 PNG、打包 `spica.ico`，同时写入 `apps/desktop/resources/branding/` 和本目录。位图永远从矢量重新生成，不要手工修位图。

选 `@resvg/resvg-js` 的理由：npm 上各平台都带预编译二进制，装上即用，不需要本机编译工具链，也不需要启动 Electron 或浏览器；同一份 SVG 在各平台渲染结果一致。

## 目录

| 文件 | 内容 |
|---|---|
| `README.md` | 本文：标志、几何、颜色、使用、重新生成 |
| `animation.md` | 状态动效与开机画面 |
| `files.md` | 每个成品文件的用途 |
| `check_icon.md` | 完成状态图标（带圈对钩）的要求 |
