// Real backend: each call starts Windows PowerShell 5.1 (present on every
// Windows 10/11, no install, no admin) hidden, hands it outlook.ps1 and one
// JSON request on stdin, and reads one JSON answer from stdout.
//
// Why a small bootstrap instead of `-File outlook.ps1`: a script file is
// subject to the execution policy (a company policy of AllSigned would block
// it); a script block built from text is not. -EncodedCommand also keeps
// quoting out of the way. PowerShell's stderr is never forwarded: it could
// contain mail text; only the error code and HRESULT reach the log.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { MailError, STATE_HINTS, mapWorkerError } from './errors.js';

const BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
  '& ([scriptblock]::Create([IO.File]::ReadAllText($env:SPICA_OUTLOOK_SCRIPT,[Text.Encoding]::UTF8)))',
].join(';');

/** 64-bit PowerShell by default; `x86` picks the 32-bit one (SysWOW64). */
export function powershellPath(env = process.env, x86 = false) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return join(root, x86 ? 'SysWOW64' : 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function powershellArgs() {
  return ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(BOOTSTRAP, 'utf16le').toString('base64')];
}

/**
 * Run one request through PowerShell. Resolves with the worker's parsed
 * answer; rejects with MailError for start failures and timeouts.
 * `spawnImpl` is replaceable for tests.
 */
export function runWorker(script, op, args, { timeoutMs = 45_000, spawnImpl = spawn, x86 = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(powershellPath(process.env, x86), powershellArgs(), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SPICA_OUTLOOK_SCRIPT: script },
      });
    } catch {
      reject(new MailError('POWERSHELL_FAILED'));
      return;
    }
    const out = [];
    let errText = '';
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new MailError('TIMEOUT')));
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', () => finish(() => reject(new MailError('POWERSHELL_FAILED'))));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      if (errText.length < 20_000) errText += d;
    });
    child.on('close', () =>
      finish(() => {
        const text = Buffer.concat(out).toString('utf8').trim();
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            resolve(parsed);
            return;
          }
        } catch {
          /* fall through */
        }
        // No JSON: PowerShell itself failed (often constrained language mode).
        const mapped = mapWorkerError({ message: errText });
        reject(mapped.code === 'COM_ERROR' ? new MailError('POWERSHELL_FAILED') : mapped);
      }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ op, args }));
  });
}

export class OutlookBackend {
  mock = false;

  constructor({ script, platform = process.platform, run = runWorker, timeoutMs } = {}) {
    this.script = script;
    this.platform = platform;
    this.run = run;
    this.timeoutMs = timeoutMs;
  }

  async call(op, args = {}) {
    if (this.platform !== 'win32') throw new MailError('NOT_WINDOWS');
    const opts = () => ({ ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}), x86: this.x86 === true });
    let answer = await this.run(this.script, op, args, opts());
    if (!answer.ok && answer.error?.code === 'NEED_32BIT_POWERSHELL' && !this.x86) {
      // 32-bit Office whose 64-bit COM registration points at a missing file:
      // switch to 32-bit PowerShell for the rest of this server's life.
      this.x86 = true;
      answer = await this.run(this.script, op, args, opts());
    }
    if (answer.ok) return answer.result;
    throw mapWorkerError(answer.error);
  }

  async status() {
    const r =
      this.platform !== 'win32'
        ? { mode: 'real', outlook: { state: 'not_installed', classic_installed: false, platform: this.platform }, mailboxes: [] }
        : await this.call('status');
    if (r.outlook) r.outlook.hint = STATE_HINTS[r.outlook.state] ?? '';
    return r;
  }
  listFolders(a) {
    return this.call('listFolders', a);
  }
  listMessages(a) {
    return this.call('listMessages', a);
  }
  readMessage(a) {
    return this.call('readMessage', a);
  }
  markRead(a) {
    return this.call('markRead', a);
  }
  moveMessages(a) {
    return this.call('moveMessages', a);
  }
  saveAttachments(a) {
    return this.call('saveAttachments', a);
  }
  createDraft(a) {
    return this.call('createDraft', a);
  }
}
