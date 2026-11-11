# 插件拉起的进程

完整说明和实测结果在 Spica 仓库 `docs/plugins/authoring.md` 第 2d 节。要点：

## Spica 怎么结束 server

停用、重装、升级、改网络设置重启、应用正常退出：先记下 server 拉起的全部进程（顺着父进程找，核对创建时间），再关 server 的 stdin；3 秒后 server 还没退就强行结束它；server 没了以后记下的进程再给最多 1 秒，还活着的逐个结束。交给 Windows 打开的程序、经已经退出的中间进程启动的程序不在名单里，不会被碰。只在 Windows 上这样做，其他系统只结束 server。停一次多花约 1.4 秒（实测，忙的电脑上）。已知限制：刚打开程序的那一刻正好停插件，交给 Windows 打开的可能没打开（不会被结束）；经自己写的中间进程打开的，中间进程还没退出时会被结束。

在 Windows 上实测（server 用 Node 写）：

| server 拉起的进程 | 停用、重装、升级、重启、应用退出 | 应用被强行结束 | 整棵进程树被结束 |
|---|---|---|---|
| 普通方式（`spawn`，不加 `detached`） | 结束 | 结束 | 结束 |
| `detached: true` | 结束（server 没了 1 秒后） | 留着 | 结束 |
| 上面两种再拉起的子进程 | 结束（server 没了 1 秒后） | 留着 | 结束 |
| 交给 Windows 打开（explorer.exe 或 WMI），或经一个马上退出的中间进程启动 | 留着 | 留着 | 留着 |

应用被强行结束时 Spica 来不及做事，留下来的进程当前文件夹在插件安装文件夹里的，之后同版本重装会报「安装文件夹仍被占用」。

## 辅助进程（替 server 干活的）

- server 和辅助进程都在 stdin 关闭时自己退出：server 用 `readline.createInterface({ input: process.stdin }).on('close', () => process.exit(0))`；辅助进程由 server 开一根 stdin 管道，读到关闭就收尾退出。
- 辅助进程不用 `detached`，也不再拉起常驻的进程（Spica 会在 server 没了 1 秒后强行结束它们，来不及收尾）。

## 替用户打开的程序（之后用户自己还要用的）

硬要求两条：程序不能挂在插件下面（否则停用、重装、升级插件或应用退出时会被 Spica 结束）；程序要拿到用户完整的环境变量（插件进程只有白名单里的变量，插件自己或经中间进程启动的程序也只有这些，靠环境变量找配置的程序会起不来）。所以交给 Windows 去打开：

```js
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// 首选：经 explorer.exe 打开，和用户双击这个程序一样。不能带参数。
export function openForUser(program) {
  if (!/\.exe$/i.test(program) || program.includes(',') || !existsSync(program)) throw new Error('not a program that explorer.exe can open: ' + program);
  spawn('explorer.exe', [program], { stdio: 'ignore' });
}

// 要带参数、指定当前文件夹或者要进程号时：经 WMI 的 Win32_Process.Create 打开。返回程序的进程号。
export function openForUserWithArgs(program, args = [], cwd = homedir()) {
  for (const a of [program, ...args]) if (a.includes('"')) throw new Error('quotes are not supported: ' + a);
  const commandLine = [program, ...args].map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:OPEN_CMD; CurrentDirectory = $env:OPEN_CWD }; "$($r.ReturnValue) $($r.ProcessId)"'],
      { windowsHide: true, env: { ...process.env, OPEN_CMD: commandLine, OPEN_CWD: cwd } },
      (err, stdout) => {
        const [code, pid] = String(stdout).trim().split(' ').map(Number);
        if (err || code !== 0) reject(new Error(`could not start ${program} (Win32_Process.Create returned ${code})`));
        else resolve(pid);
      },
    );
  });
}
```

- explorer.exe：没查到微软写这种用法的文档（实测行为）。不能带参数，路径里不能有逗号（带了不启动程序，反而开一个文件夹窗口）；退出码恒为 1，拿不到进程号；路径不对不报错，调用前先确认是存在的 `.exe`；当前文件夹固定是 `C:\Windows\System32`。
- WMI：有文档；返回 0 是成功，给出进程号；参数里不能有双引号，带空格又以反斜杠结尾的参数先去掉末尾的反斜杠。文档写着这样起的进程受作业对象限制，在 Windows 11 上实测不在作业对象里，别的版本先核。公司电脑上的安全软件可能拦「WMI 服务拉起程序」，用前在目标电脑上试一次。
- 从插件自带的 `.exe` 里打开程序：执行 `explorer.exe "<程序>"`，或者上面那行 PowerShell。
- 不推荐自己写中间进程（Node `detached` 启动后马上退出，或 `Start-Process`）：程序不挂在插件下面，但拿到的是插件的环境变量。非这样不可时，要重建整套用户环境：不要用 `Start-Process -UseNewEnvironment`（实测缺 `SystemRoot`、`USERPROFILE`、`APPDATA` 这些）；`.exe` 里用 `CreateEnvironmentBlock`，再补上 `USERNAME`、`USERDOMAIN`。只在 `.exe` 里加 `DETACHED_PROCESS` / `CREATE_NEW_PROCESS_GROUP` / `CREATE_BREAKAWAY_FROM_JOB` 不够：父进程还是插件。
- 有界面的程序不要加 `windowsHide` / `-WindowStyle Hidden`。
- `check.mjs` 不查这一条（单看代码分不出是辅助进程还是替用户打开的程序；`.exe` 里怎么开程序看不到），交付前自己核一遍。

## 重的辅助进程：用到才起，空闲就退

一开就占几十上百 MB、一天只用几次的辅助进程，用到时才拉起，空闲一段时间（例如 10 分钟）关掉它的 stdin 让它收尾退出，下次调用再拉起；server 本身照常开着。完整写法（`withHelper`，实测过）和注意点在作者指南第 2f 节：拉起失败返回 `isError` 和一句人话、第一次调用慢时报进度、当前文件夹设在 `SPICA_PLUGIN_DATA`。
