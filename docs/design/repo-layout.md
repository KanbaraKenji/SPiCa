# 仓库布局与约定

> 适用范围：Spica 仓库的目录、工具链和全仓约定。新增包、新增脚本、新增子进程前先看「约定」一节。

## 目录

```
apps/desktop/            Electron 应用（见 desktop-shell.md）
  src/main/              主进程：窗口、设置、更新与公告、监护后端进程
  src/backend/           后端进程入口：在 utilityProcess 里跑内核和链接进来的模块
  src/preload/           唯一的桥：把 window.spica 暴露给界面
  src/renderer/          界面（React）
  src/shared/            主进程和界面共用的代码（皮肤、缩放、IPC 名）
  resources/branding/    打包用的品牌成品（图标、横标）
  electron-builder.yml   打包配置：按用户安装 + 便携版
packages/core/           @spica/core：Agent 内核（agent-core.md）
packages/protocol/       @spica/protocol：后端接口与事件的类型定义（接口先行的「合同」）
packages/extract/        @spica/extract：读 PDF / Word / Excel 等（file-extract.md）
packages/plugins/        @spica/plugins：插件系统（plugins.md）
packages/brand/          @spica/brand：标志几何、字标、开机动画、成品生成
plugins/                 官方插件，一个插件一个文件夹（example-notes、outlook-mail）
branding/                品牌说明书和字体（成品由 @spica/brand 生成）
scripts/sensitive-words/ 敏感词扫描（脚本 + 示例词表 + 测试）
scripts/release/         发版：prepare.mjs 改版本号、提交、打 tag
scripts/acceptance.mjs   一次跑完自动验收旅程并出汇总
docs/                    文档，索引见 docs/README.md；design/ 下是中文设计文档
.github/workflows/       ci.yml（每次推送检查）、release.yml（推 tag 出安装包）
```

根目录文件：`package.json`（workspaces 和统一脚本）、`README.md`、`CONTRIBUTING.md`、`tsconfig.base.json`（所有包继承）、`eslint.config.mjs`、`vitest.config.mts`、`.env.example`、`LICENSE`、`NOTICE`。

不进仓库（`.gitignore`）：维护者的工作笔记（PROMPT.md、LEDGER.md、ledger-*、scripts/dev/open-subsession.ps1）、`.idea/`、`.venv/`、`.env.local`、各处的 `out/` 和 `release/`（构建产物、验收汇总、安装包）。

## 选择与理由

| 选择 | 理由 |
|---|---|
| Electron + Vite + React + TypeScript | Electron 自带 Node，插件的 Node 类 MCP server 直接用宿主的 Node，用户不用装任何东西；插件作者用同一套 TS/React 写界面视图和代码钩子。 |
| npm workspaces，不用 pnpm | Node 自带 npm，clone 后 `npm install` 即可，不要求另装包管理器。 |
| electron-vite 6 | 只当「胶水」：一条命令同时构建 main / preload / renderer 并热更新。可替换，不是架构决定。 |
| TypeScript 6.0.3（不是 7） | typescript-eslint 目前只支持到 TS 6.0；等它支持 7 再升。 |
| ESLint 10 flat 配置 + typescript-eslint | 业界默认；全仓一份配置，包里不另配。 |
| Vitest 5 | 和 Vite 同源，TS 直接跑；全仓一份配置，测试文件与源码放一起（`*.test.ts`）。 |
| 工作区包「源码直出」 | `@spica/*` 的 `main` 直接指向 `src/index.ts`，不单独编译；桌面端构建时整个打包进去。少一层构建步骤，改了马上生效。 |
| 工作区包写在 devDependencies | electron-vite 默认把 `dependencies` 当外部依赖、运行时去 node_modules 找；`@spica/*` 是 TS 源码，必须打包进去，所以放 devDependencies。真正运行时要的第三方库才放 `dependencies`。 |
| 界面只通过 preload 桥调后端 | renderer 开 sandbox + contextIsolation，不能直接碰 Node；所有能力都是后端接口，界面只是外壳，和「接口先行」一致。 |
| 花标用代码现画 | 几何（瓣形、40° 间隔、长瓣 0/120/240°、轴半径 4.5、放大 1.15、花心 (32,37)）集中在 `@spica/brand` 的 `geometry.ts`，有测试锁住；短瓣和轴用 `currentColor`，长瓣用 `--spica-accent`，系统明暗、以后换皮肤都不用新图。 |
| Electron 45 | 当前稳定版。它不再在 `npm install` 时下载本体，而 electron-vite 找不到本体会直接报错；所以 `apps/desktop` 加了 `predev` / `prepreview`（`install-electron`），第一次 `npm run dev` 时下载（约 100 MB），之后秒过。CI 不开窗口，不下载。 |

## 加一个新包

1. 建文件夹：内部库放 `packages/<name>/`，官方插件放 `plugins/<name>/`，应用放 `apps/<name>/`。
2. `package.json`：`"name": "@spica/<name>"`（插件用 `@spica/plugin-<name>`）、`"private": true`、`"type": "module"`、`"license": "Apache-2.0"`、`main`/`types` 指向 `./src/index.ts`、`"scripts": { "typecheck": "tsc -p tsconfig.json" }`。
3. `tsconfig.json`：`"extends": "../../tsconfig.base.json"`，`include: ["src"]`；用 Node API 的加 `"types": ["node"]`。
4. 写一个英文 `README.md`：它做什么、现在到哪一步。
5. 别的包要用它：在使用方的 `devDependencies` 里加 `"@spica/<name>": "*"`，然后在根目录 `npm install`。
6. 不用改根配置：`npm run typecheck` 会自动跑到新包，`npm test` 和 `npm run lint` 本来就覆盖全仓。

## 约定

- **不弹控制台窗口**：任何子进程（`spawn` / `execFile` / `exec` / `fork`）一律带 `windowsHide: true`；不用 `shell: true`，不直接起 `.cmd` / `.bat`。Node 类子进程用宿主自带的 Node：`process.execPath` + 环境变量 `ELECTRON_RUN_AS_NODE=1`。打包产物是 GUI 程序，不带控制台。
- **不需要管理员权限**：打包走 electron-builder 的 NSIS per-user 安装（`perMachine: false`，装到用户目录）或便携版；不写 HKLM、不装服务、不依赖系统预装组件。配置在 `apps/desktop/electron-builder.yml`，`npm run dist` 出包。
- **模型 key 永远不进仓库**：本机配置写在根目录 `.env.local`（已忽略），变量名见 `.env.example`：`SPICA_OPENAI_BASE_URL`、`SPICA_OPENAI_API_KEY`、`SPICA_OPENAI_MODEL`、`SPICA_OPENAI_MODEL_STRONG`、`SPICA_ANTHROPIC_API_KEY`、`SPICA_ANTHROPIC_MODEL`。`npm run smoke:deepseek` / `smoke:claude` 用这些变量对真模型做冒烟测试，实现在 `@spica/core`。
- **语言**：README、代码注释、提交信息用英文；`docs/design/` 下的设计文档用中文。
- **命名**：工作区包 `@spica/<name>`，全部 `private: true`，是否发布以后再定。应用默认名 Spica，以后可自定义。
- **不装全局东西**：所有工具都是仓库内的 devDependencies，通过 `npm run` 调用。
- **版本写死**：依赖版本写确切版本号，提交 `package-lock.json`；CI 用 `npm ci`。
- **示例中立**：示例、文档、测试数据只用通用或虚构场景，不出现任何公司或行业专属内容。敏感词扫描兜底。

## 敏感词扫描

- 脚本：`scripts/sensitive-words/scan.mjs`，纯 Node，无依赖；`npm run scan:sensitive`。
- 扫哪些文件：git 跟踪的文件和未被忽略的新文件；跳过二进制文件和词表文件本身。
- 词表：仓库只带 `words.example.txt`（通用示例词），永远参与扫描。私有仓追加自己的词表，三种方式任选：
  - 环境变量 `SPICA_SENSITIVE_WORDS`：词表文件路径，多个用 `;`（Windows）分隔；
  - 命令行 `--words <路径>`，可重复；
  - CI 里设仓库 secret `SPICA_SENSITIVE_WORDS_LIST`，内容就是词表正文，workflow 会写成临时文件再扫。
- 词表格式：一行一个词，`#` 开头是注释，不区分大小写，按子串匹配。
- 命中：打印 `文件:行号` 和「第几个词表的第几行」，CI 失败；**不回显词本身**，免得私有词表漏进 CI 日志。

## 开发开关

- `SPICA_THEME=dark|light`：强制明暗，不跟系统。
- `SPICA_CAPTURE=<文件.png>`：开窗渲染一次，存截图后退出。`docs/screenshots/skeleton.png` 就是这样生成的：

  ```powershell
  $env:SPICA_THEME='dark'; $env:SPICA_CAPTURE="$PWD\docs\screenshots\skeleton.png"; npm run dev
  ```

## 验收与发版

- **一次跑完验收**：`npm run acceptance`，依次跑内核旅程（J2 J3 J4 J5 J7，真模型）、插件旅程（J6，真模型）、截图矩阵（J8），汇总打印并存到 `out/acceptance/summary-<时间>.md`；`-- --only core,j6,shots` 只跑其中几段。没有 `.env.local` 时两段真模型旅程记「跳过」，整体算「不完整」。J1 手动验。
  - 注意：截图那一段会重写 `docs/screenshots/shell/` 下已提交的图，跑完要么提交、要么 `git checkout -- docs/screenshots/shell`。
- **发版**：
  1. `npm run release:prepare -- 0.2.0`（或 `patch` / `minor` / `major`）：改根和 `apps/desktop` 的 package.json 和锁文件里的版本号，只把这三个文件提交成「Release v0.2.0」，再打附注 tag `v0.2.0`；不推送。这三个文件有未提交改动、或暂存区里有别的东西时直接拒绝。`--dry-run` 只看不改。
  2. 推 tag（`git push origin main v0.2.0`）触发 `.github/workflows/release.yml`：在 windows-latest 上跑检查，再 `npm run dist` 出按用户安装包和便携版，用 `GITHUB_TOKEN` 建 GitHub Release，附上安装包、blockmap、便携版和 `latest.yml`。
  - **试跑不发布**：推一个名字以 `ci/release-dryrun` 开头的分支，跑同一套检查和 `npm run dist`，安装包、便携版、blockmap、`latest.yml` 只作为 workflow artifacts 上传（保留 7 天），不建 Release、不打 tag；版本号用 `apps/desktop/package.json` 里的。
  - 版本号以 tag 为准：tag 和 package.json 对不上时按 tag 出包并留一条警告。带 `-` 的版本（如 `0.2.0-beta.1`）标成预发布。
  - 没有代码签名证书，出的是未签名包（Windows 首次运行可能提示「未知发布者」）。
