// COM / PowerShell failure → error code mapping, without Outlook.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HRESULT_CODES, MESSAGES, MailError, formatError, mapWorkerError, normalizeHresult } from '../server/errors.js';
import { OutlookBackend, runWorker } from '../server/outlook-backend.js';
import { callTool } from '../server/tools.js';

describe('HRESULT mapping', () => {
  it('normalizes the ways an HRESULT arrives', () => {
    expect(normalizeHresult(-2147221164)).toBe('0x80040154');
    expect(normalizeHresult('0x80040154')).toBe('0x80040154');
    expect(normalizeHresult('-2147467260')).toBe('0x80004004');
    expect(normalizeHresult(undefined)).toBeUndefined();
    expect(normalizeHresult('nonsense')).toBeUndefined();
  });

  it.each([
    ['0x80040154', 'OUTLOOK_NOT_INSTALLED'],
    ['0x800401E3', 'OUTLOOK_NOT_RUNNING'],
    ['0x800706BA', 'OUTLOOK_NOT_RUNNING'],
    ['0x80080005', 'OUTLOOK_NOT_RUNNING'],
    ['0x80010001', 'OUTLOOK_BUSY'],
    ['0x8001010A', 'OUTLOOK_BUSY'],
    ['0x80004004', 'OUTLOOK_SECURITY_BLOCKED'],
    ['0x80070005', 'OUTLOOK_SECURITY_BLOCKED'],
    ['0x8004010F', 'MESSAGE_NOT_FOUND'],
    ['0x12345678', 'COM_ERROR'],
  ])('%s → %s', (hr, code) => {
    const e = mapWorkerError({ hresult: hr });
    expect(e.code).toBe(code);
    expect(formatError(e)).toMatch(new RegExp(`^\\[${code}\\] .+（错误代码 ${hr}）$`));
  });

  it('every mapped code has a message', () => {
    for (const code of Object.values(HRESULT_CODES)) expect(MESSAGES[code]).toBeTruthy();
  });

  it('keeps codes the worker decided itself, with its detail', () => {
    expect(mapWorkerError({ code: 'OUTLOOK_NO_PROFILE' }).code).toBe('OUTLOOK_NO_PROFILE');
    const f = mapWorkerError({ code: 'FOLDER_NOT_FOUND', detail: 'Inbox/Old' });
    expect(f.message).toContain('「Inbox/Old」');
    expect(mapWorkerError({ code: 'NOT_A_CODE', hresult: '0x80010001' }).code).toBe('OUTLOOK_BUSY');
  });

  it('recognizes constrained language mode and a silent worker', () => {
    expect(mapWorkerError({ message: 'Cannot invoke method. Method invocation is supported only on core types in this language mode.' }).code).toBe('POWERSHELL_RESTRICTED');
    expect(mapWorkerError({ message: '' }).code).toBe('COM_ERROR');
    expect(mapWorkerError(undefined).code).toBe('POWERSHELL_FAILED');
  });
});

/** A child process stand-in for runWorker's spawnImpl. */
function fakeSpawn({ stdout = '', stderr = '', error, hang = false } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      child.killed = true;
    };
    setImmediate(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (hang) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  return { impl, calls };
}

describe('PowerShell worker', () => {
  it('starts PowerShell hidden with no profile and an encoded bootstrap', async () => {
    const f = fakeSpawn({ stdout: '{"ok":true,"result":{"x":1}}' });
    const r = await runWorker('C:\\p\\outlook.ps1', 'status', {}, { spawnImpl: f.impl });
    expect(r).toEqual({ ok: true, result: { x: 1 } });
    const { cmd, args, opts } = f.calls[0];
    expect(cmd).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']));
    expect(opts.windowsHide).toBe(true);
    expect(opts.shell).toBeUndefined();
    expect(opts.env.SPICA_OUTLOOK_SCRIPT).toBe('C:\\p\\outlook.ps1');
    const boot = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(boot).toContain('[scriptblock]::Create');
    expect(boot).toContain('UTF8Encoding');
  });

  it('maps start failure, garbage, restricted mode and timeout', async () => {
    await expect(runWorker('s', 'status', {}, { spawnImpl: fakeSpawn({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }).impl })).rejects.toMatchObject({ code: 'POWERSHELL_FAILED' });
    await expect(runWorker('s', 'status', {}, { spawnImpl: fakeSpawn({ stdout: 'not json' }).impl })).rejects.toMatchObject({ code: 'POWERSHELL_FAILED' });
    await expect(
      runWorker('s', 'status', {}, { spawnImpl: fakeSpawn({ stderr: '#< CLIXML <S S="Error">... only on core types in this language mode.</S>' }).impl }),
    ).rejects.toMatchObject({ code: 'POWERSHELL_RESTRICTED' });
    const hang = fakeSpawn({ hang: true });
    await expect(runWorker('s', 'status', {}, { spawnImpl: hang.impl, timeoutMs: 50 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('turns worker errors into tool errors', async () => {
    const backend = new OutlookBackend({ script: 's', platform: 'win32', run: async () => ({ ok: false, error: { hresult: '0x80004004' } }) });
    const r = await callTool(backend, 'list_messages', {});
    expect(r).toEqual({ isError: true, text: expect.stringMatching(/^\[OUTLOOK_SECURITY_BLOCKED\] /) });
    expect(r.text).not.toContain('[sample data');
  });

  it('says NOT_WINDOWS off Windows, and status still answers', async () => {
    const backend = new OutlookBackend({ script: 's', platform: 'linux', run: async () => ({ ok: true, result: {} }) });
    expect((await callTool(backend, 'read_message', { id: 'x' })).text).toMatch(/^\[NOT_WINDOWS\] /);
    const st = await callTool(backend, 'status', {});
    expect(st.isError).toBe(false);
    expect(JSON.parse(st.text).outlook).toMatchObject({ state: 'not_installed', classic_installed: false, hint: expect.stringContaining('没有装 Outlook') });
  });

  it('formats unknown failures without leaking their text', () => {
    expect(formatError(new Error('Subject: secret salary review'))).toBe(`[COM_ERROR] ${MESSAGES.COM_ERROR}`);
    expect(new MailError('TIMEOUT').code).toBe('TIMEOUT');
  });
});

describe('32-bit Office', () => {
  it('switches to 32-bit PowerShell when the worker asks for it, and stays there', async () => {
    const seen = [];
    const run = async (_s, op, _a, opts) => {
      seen.push(opts.x86);
      if (!opts.x86) return { ok: false, error: { code: 'NEED_32BIT_POWERSHELL' } };
      return { ok: true, result: { mode: 'real', outlook: { state: 'no_profile' }, mailboxes: [] } };
    };
    const backend = new OutlookBackend({ script: 's', platform: 'win32', run });
    const st = await callTool(backend, 'status', {});
    expect(JSON.parse(st.text).outlook.hint).toContain('还没有配置邮箱账号');
    await callTool(backend, 'status', {});
    expect(seen).toEqual([false, true, true]);
  });

  it('picks the SysWOW64 PowerShell for x86', async () => {
    const { powershellPath } = await import('../server/outlook-backend.js');
    expect(powershellPath({ SystemRoot: 'C:\\Windows' }, true)).toMatch(/SysWOW64[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toMatch(/System32[\\/]WindowsPowerShell/);
  });
});
