# 插件拉起的进程

完整说明和实测结果在 Spica 仓库 `docs/plugins/authoring.md` 第 2d 节。要点：

## Spica 怎么结束 server

停用、重装、升级、改网络设置重启、应用正常退出：先记下 server 拉起的全部进程（顺着父进程找，核对创建时间），再关 server 的 stdin；3 秒后 server 还没退就强行结束它；server 没了以后记下的进程再给最多 1 秒，还活着的逐个结束。经已经退出的中间进程启动的程序不在名单里，不会被碰。只在 Windows 上这样做，其他系统只结束 server。停一次多花约 1.4 秒（实测，忙的电脑上）。已知限制：中间进程还没退出的那一刻正好停插件，刚打开的程序会被结束。

在 Windows 上实测（server 用 Node 写）：

| server 拉起的进程 | 停用、重装、升级、重启、应用退出 | 应用被强行结束 | 整棵进程树被结束 |
|---|---|---|---|
| 普通方式（`spawn`，不加 `detached`） | 结束 | 结束 | 结束 |
| `detached: true` | 结束（server 没了 1 秒后） | 留着 | 结束 |
| 上面两种再拉起的子进程 | 结束（server 没了 1 秒后） | 留着 | 结束 |
| 经一个马上退出的中间进程启动 | 留着 | 留着 | 留着 |

应用被强行结束时 Spica 来不及做事，留下来的进程当前文件夹在插件安装文件夹里的，之后同版本重装会报「安装文件夹仍被占用」。

## 辅助进程（替 server 干活的）

- server 和辅助进程都在 stdin 关闭时自己退出：server 用 `readline.createInterface({ input: process.stdin }).on('close', () => process.exit(0))`；辅助进程由 server 开一根 stdin 管道，读到关闭就收尾退出。
- 辅助进程不用 `detached`，也不再拉起常驻的进程（Spica 会在 server 没了 1 秒后强行结束它们，来不及收尾）。

## 替用户打开的程序（之后用户自己还要用的）

硬要求：必须经一个马上退出的中间进程启动，否则停用、重装、升级插件或应用退出时会被 Spica 结束。当前文件夹设到插件文件夹外面，去掉 `ELECTRON_RUN_AS_NODE`：

```js
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const LAUNCH = `
const [program, cwd, ...args] = process.argv.slice(1);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
require('node:child_process').spawn(program, args, { cwd, env, detached: true, stdio: 'ignore' }).unref();
`;
export function openForUser(program, args = [], cwd = homedir()) {
  spawn(process.execPath, ['-e', LAUNCH, program, cwd, ...args], { stdio: 'ignore', windowsHide: true });
}

// 或者用 PowerShell 的 Start-Process
export function openForUserPowerShell(program, cwd = homedir()) {
  const env = { ...process.env, OPEN_PROGRAM: program, OPEN_CWD: cwd };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:OPEN_PROGRAM -WorkingDirectory $env:OPEN_CWD'],
    { stdio: 'ignore', windowsHide: true, env });
}
```

- 只加 `detached`，或者在 `.exe` 里只加 `DETACHED_PROCESS` / `CREATE_NEW_PROCESS_GROUP` / `CREATE_BREAKAWAY_FROM_JOB`，都不够：父进程还是插件，整棵进程树被结束时会被一起结束。
- 从插件自带的 `.exe` 里打开程序，也经中间进程，例如 `powershell.exe -NoProfile -Command "Start-Process -FilePath '<程序>' -WorkingDirectory '<文件夹>'"`。
- 有界面的程序不要加 `windowsHide` / `-WindowStyle Hidden`。
- `check.mjs` 不查这一条（推荐写法里中间进程本身就用 `detached`，单看代码分不出对错；`.exe` 里怎么开程序看不到），交付前自己核一遍。

## 重的辅助进程：用到才起，空闲就退

一开就占几十上百 MB、一天只用几次的辅助进程，用到时才拉起，空闲一段时间（例如 10 分钟）关掉它的 stdin 让它收尾退出，下次调用再拉起；server 本身照常开着。完整写法（`withHelper`，实测过）和注意点在作者指南第 2f 节：拉起失败返回 `isError` 和一句人话、第一次调用慢时报进度、当前文件夹设在 `SPICA_PLUGIN_DATA`。
