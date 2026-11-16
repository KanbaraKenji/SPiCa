// run_command in approval mode Auto: the fixed rules of command-scope.ts. A command that writes outside the
// conversation's folders is confirmed (cause outside_folder); one inside runs; Manual is unchanged (every command asks).
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandOutside, tooWideToAllow } from './command-scope.ts';
import { inScope, realPath } from './write-scope.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import { runCommandTool } from './tools/command-tool.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let cleanup: () => Promise<void>;
let work: string;
let out: string;
beforeEach(async () => {
  ({ dir: root, cleanup } = await tempDir());
  work = join(root, 'work');
  out = join(root, 'elsewhere');
  await mkdir(work);
  await mkdir(out);
});
afterEach(async () => {
  await cleanup();
});

const win = process.platform === 'win32';
const check = (command: string, cwd = work, hasCwd = false) => commandOutside(command, cwd, [work], hasCwd);

describe('the rules, on the command as written', () => {
  it('inside the folders: nothing (relative paths, absolute ones inside, reading from outside)', () => {
    for (const c of [
      'Set-Content notes.txt "hi"',
      `Set-Content -Path "${join(work, 'a.txt')}" -Value x`,
      'echo hi > out.txt',
      `Get-Content "${join(out, 'a.txt')}"`,
      `Copy-Item "${join(out, 'a.txt')}" .\\copy.txt`,
      `copy "${join(out, 'a.txt')}"`,
      'npm install',
      'git commit -m "x > y"',
      'dir 2>&1',
      'Remove-Item tmp -Recurse > $null',
    ]) {
      expect(check(c), c).toBeUndefined();
    }
  });

  it('PowerShell: Set-Content, Out-File, Remove-Item, New-Item, Move-Item and their aliases outside', () => {
    const f = join(out, 'a.txt');
    for (const c of [`Set-Content -Path "${f}" -Value x`, `"x" | Out-File '${f}'`, `Remove-Item "${f}"`, `ni "${f}" -ItemType File`, `Move-Item a.txt "${f}"`, `Add-Content -Path:${f} x`]) {
      expect(check(c), c).toMatchObject({ folder: realPath(out), rule: 'write' });
    }
  });

  it('redirection (> and >>) to a file outside, in any shell', () => {
    const f = join(out, 'log.txt');
    expect(check(`echo hi > "${f}"`)).toMatchObject({ folder: realPath(out), path: f, rule: 'write' });
    expect(check(`dir >>"${f}"`)).toMatchObject({ folder: realPath(out), rule: 'write' });
    expect(check(`Get-Date 2>&1 > "${f}"`)).toMatchObject({ folder: realPath(out), rule: 'write' });
  });

  it('cmd: del, move, copy and xcopy (only where it copies to), also after cmd /c', () => {
    const f = join(out, 'a.txt');
    expect(check(`del "${f}"`)).toMatchObject({ folder: realPath(out) });
    expect(check(`cmd /c del "${f}"`)).toMatchObject({ folder: realPath(out) });
    expect(check(`copy notes.txt "${out}"`)).toMatchObject({ folder: realPath(out), rule: 'write' });
    expect(check(`xcopy src "${out}" /E /Y`)).toMatchObject({ folder: realPath(out) });
    expect(check(`robocopy src "${out}" *.txt /MIR`)).toMatchObject({ folder: realPath(out) });
    expect(check(`robocopy "${out}" dest`)).toBeUndefined();
  });

  it('bash: cp, mv, rm, mkdir, tee, sed -i', () => {
    const f = join(out, 'a.txt');
    for (const c of [`cp notes.txt "${f}"`, `mv a.txt "${f}"`, `rm -f "${f}"`, `mkdir -p "${join(out, 'x')}"`, `echo hi | tee "${f}"`, `sed -i s/a/b/ "${f}"`]) {
      expect(check(c), c).toMatchObject({ folder: realPath(out) });
    }
    expect(check(`sed s/a/b/ "${f}"`)).toBeUndefined();
  });

  it('a relative path climbing out with .., and the home folder written as ~ or $env:USERPROFILE', () => {
    expect(check('Set-Content ..\\elsewhere\\a.txt x')).toMatchObject({ folder: realPath(out) });
    expect(check('Set-Content ~\\spica-test-x.txt x')).toMatchObject({ folder: realPath(homedir()) });
    expect(check('Remove-Item $env:USERPROFILE\\spica-test-x.txt')).toMatchObject({ folder: realPath(homedir()) });
  });

  it('1: run in a folder outside (its cwd), or a cd to one before something that writes', () => {
    expect(check('dir', out, true)).toMatchObject({ folder: realPath(out), rule: 'cwd' });
    expect(check(`cd "${out}"; Set-Content a.txt x`)).toMatchObject({ folder: realPath(out), rule: 'cwd' });
    expect(check(`cd "${out}"; dir`)).toBeUndefined();
    expect(check(`Set-Location "${out}"; echo hi > a.txt`)).toMatchObject({ rule: 'cwd' });
  });

  it('3: a recursive delete of a drive’s root or the home folder; neither is ever kept as allowed', () => {
    const drive = parse(work).root;
    expect(check(`Remove-Item ${drive}* -Recurse -Force`)).toMatchObject({ rule: 'sweep' });
    expect(check('rm -rf ~')).toMatchObject({ rule: 'sweep', folder: realPath(homedir()) });
    if (win) expect(check('rd /s /q %USERPROFILE%')).toMatchObject({ rule: 'sweep' });
    expect(tooWideToAllow(drive)).toBe(true);
    expect(tooWideToAllow(homedir())).toBe(true);
    expect(tooWideToAllow(out)).toBe(false);
  });

  it('what it does not see, as written in the design doc: a script, a path in a variable, an interpreter’s one-liner', () => {
    const f = join(out, 'a.txt');
    expect(check('python write.py')).toBeUndefined();
    expect(check(`$p = '${f}'; Set-Content $p x`)).toBeUndefined();
    expect(check(`python -c "open(r'${f}','w').write('x')"`)).toBeUndefined();
  });
});

describe('a short (8.3) name and the long one are the same folder', () => {
  // Windows gives a long folder name a short alias, and a path may be written either way (the CI machine's temp
  // folder is C:\Users\RUNNER~1\…, the real one …\runneradmin\…). The scope, the folder on the card and the
  // root / home check compare real paths, so neither way round is taken for another folder. The folder on the card
  // is the real (long) one. A volume that makes no short names skips this (it says so).
  const shortOf = (p: string) => spawnSync('cmd.exe', [`/d /s /c "for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();

  it.skipIf(!win)('both ways round: inside stays inside, outside says the real folder', async (ctx) => {
    const long = join(root, 'a folder with a long name');
    await mkdir(long);
    const short = shortOf(long);
    if (short.toLowerCase() === long.toLowerCase()) ctx.skip();
    const inLong = join(long, 'x.txt');
    const inShort = join(short, 'x.txt');
    expect(realPath(short)).toBe(realPath(long));
    expect(inScope(inShort, [long])).toBe(true);
    expect(inScope(inLong, [short])).toBe(true);
    expect(commandOutside(`Set-Content -Path "${inShort}" -Value x`, work, [work, long])).toBeUndefined();
    expect(commandOutside(`Set-Content -Path "${inLong}" -Value x`, work, [work, short])).toBeUndefined();
    expect(commandOutside('dir', short, [work, long], true)).toBeUndefined();
    expect(commandOutside(`Set-Content -Path "${inShort}" -Value x`, work, [work])).toMatchObject({ folder: realPath(long), path: inShort });
  });
});

describe('in a conversation', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  const run = async (command: string, approvalMode: 'manual' | 'auto') => {
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'run_command', args: { command } }] }, { text: 'done' });
    const rt = makeRuntime(gw, { tools: [runCommandTool] });
    const events = captureEvents(rt);
    const s = rt.createSession({ cwd: work, approvalMode });
    const r = await s.send('go').done;
    return { r, s, req: events.find((e) => e.type === 'confirm.request') as { cause?: string; outsideFolder?: string } | undefined };
  };
  const writeOut = (f: string) => (win ? `Set-Content -Path '${f}' -Value x` : `echo x > '${f}'`);

  it('Auto: a command writing outside is asked (outside_folder, the folder); declined, nothing is written', async () => {
    const f = join(out, 'made.txt');
    const { r, s, req } = await run(writeOut(f), 'auto');
    expect(r.reason).toBe('awaiting_confirm');
    expect(req).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(out) });
    gw.enqueue({ text: 'ok' });
    await (await s.confirm('c1', false))!;
    await expect(readFile(f, 'utf8')).rejects.toThrow();
  });

  it('Auto: a command inside runs without asking', async () => {
    const { r, req } = await run(win ? "Set-Content -Path 'in.txt' -Value x" : 'echo x > in.txt', 'auto');
    expect(req).toBeUndefined();
    expect(r.reason).toBe('completed');
    expect((await readFile(join(work, 'in.txt'), 'utf8')).trim()).toBe('x');
  });

  it('Auto, allowed for the folder: the next command writing there is not asked', async () => {
    const { s } = await run(writeOut(join(out, 'a.txt')), 'auto');
    gw.enqueue({ text: 'ok' });
    await (await s.confirm('c1', true, { allowFolder: true }))!;
    gw.enqueue({ toolCalls: [{ id: 'c2', name: 'run_command', args: { command: writeOut(join(out, 'b.txt')) } }] }, { text: 'done' });
    expect((await s.send('again').done).reason).toBe('completed');
  });

  it('Manual: every command asks as before, with no outside mark', async () => {
    const { req } = await run(writeOut(join(out, 'a.txt')), 'manual');
    expect(req).toBeDefined();
    expect(req?.cause).toBeUndefined();
    expect(req?.outsideFolder).toBeUndefined();
  });
});
