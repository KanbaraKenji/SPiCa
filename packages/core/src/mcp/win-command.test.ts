import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { escapeArgument, findCommand, windowsLaunch } from './win-command.ts';

const win = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 'spica-wincmd-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('windowsLaunch', () => {
  it('leaves the command alone off Windows', () => {
    expect(windowsLaunch('npx', ['-y', 'a b'], {}, undefined, 'linux')).toEqual({ command: 'npx', args: ['-y', 'a b'] });
  });

  it('quotes each argument and escapes what cmd reads', () => {
    expect(escapeArgument('a b', false)).toBe('^"a^ b^"');
    expect(escapeArgument('x&y', false)).toBe('^"x^&y^"');
    expect(escapeArgument('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeArgument('D:\\dir\\', false)).toBe('^"D:\\dir\\\\^"');
  });

  it.runIf(win)('finds a .cmd on PATH by its bare name, as Windows does', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'tool.cmd'), '@echo off\r\n');
    expect(findCommand('tool', { Path: `C:\\nowhere;${bin}`, PATHEXT: '.EXE;.CMD' })?.toLowerCase()).toBe(join(bin, 'tool.cmd').toLowerCase());
    expect(findCommand('missing', { PATH: bin })).toBeUndefined();
  });

  it.runIf(win)('a .cmd gets every argument through cmd as it was given (spaces, &, quotes, %, ^, empty)', () => {
    const bin = join(dir, 'with space');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'echo-args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    writeFileSync(join(bin, 'echo-args.cmd'), `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`);
    const args = ['-y', 'D:\\Team Share\\Docs (2026)', 'a&b', 'say "hi"', '50%', 'x^y', 'semi;colon', 'trail\\', 'pipe|it', '<in>', ''];
    const env = { PATH: `${bin};${process.env.PATH ?? ''}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: process.env.SystemRoot ?? '' };
    const l = windowsLaunch('echo-args', args, env);
    expect(l.windowsVerbatimArguments).toBe(true);
    const r = spawnSync(l.command, l.args, { env, windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true });
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.stdout)).toEqual(args);
  });

  it.runIf(win)('starts a program that is not a batch file directly', () => {
    const l = windowsLaunch(process.execPath, ['-v'], { PATH: '' });
    expect(l).toEqual({ command: process.execPath, args: ['-v'] });
  });
});
