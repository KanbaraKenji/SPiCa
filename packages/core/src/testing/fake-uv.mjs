// A stand-in for uv in tests (python-env.test.ts), run as `node fake-uv.mjs <config.json> <uv arguments>`
// (config: { log, fail, failText, pythonUrl }): appends what it was asked (arguments and the UV_* / proxy
// variables) to log, and acts out just enough of uv: listing a Python download, "installing" Python, making a virtual
// environment, resolving, dry runs, installing and listing packages. Exit 3 when config.fail names the command
// (e.g. "pip install").
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const args = process.argv.slice(3);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(UV_|SSL_CERT_FILE$|HTTPS?_PROXY$|NO_PROXY$|VIRTUAL_ENV$)/i.test(k)));
if (config.log) appendFileSync(config.log, JSON.stringify({ args, env }) + '\n');
const cmd = args.slice(0, 2).join(' ');
if (config.fail && cmd === config.fail) {
  process.stderr.write(`${config.failText ?? 'error: Failed to fetch: https://pypi.example.com/simple/nope/'}\n`);
  process.exit(3);
}
const pinsFor = (names) =>
  names.flatMap((n) => (n === 'pandas' ? ['pandas==2.3.3', 'numpy==2.3.4'] : [`${n}==1.0.0`]));
const value = (flag) => args[args.indexOf(flag) + 1];
const envDir = (python) => join(python, '..', '..');
const installed = (python) => join(envDir(python), 'installed.json');

if (cmd === 'python list') {
  process.stdout.write(JSON.stringify([
    { key: 'pypy-3.12.15-windows-x86_64-none', version: '3.12.15', url: 'https://example.com/pypy.zip', implementation: 'pypy' },
    { key: 'cpython-3.12.16-windows-x86_64-none', version: '3.12.16', url: config.pythonUrl, implementation: 'cpython' },
  ]));
} else if (cmd === 'python install') {
  mkdirSync(join(process.env.UV_PYTHON_INSTALL_DIR, 'cpython-3.12.16'), { recursive: true });
  writeFileSync(join(process.env.UV_PYTHON_INSTALL_DIR, 'cpython-3.12.16', 'python.exe'), 'x'.repeat(1000));
} else if (cmd.startsWith('venv')) {
  const dir = args[args.length - 1];
  const bin = join(dir, process.platform === 'win32' ? 'Scripts' : 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  writeFileSync(join(dir, 'pyvenv.cfg'), 'home = x\nimplementation = CPython\nversion_info = 3.12.16\n');
  writeFileSync(join(dir, 'installed.json'), '[]');
} else if (cmd === 'pip compile') {
  const names = readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
  process.stdout.write(pinsFor(names).join('\n') + '\n');
} else if (cmd === 'pip install') {
  const python = value('--python');
  const names = args.slice(args.indexOf('--python') + 2);
  const have = JSON.parse(readFileSync(installed(python), 'utf8'));
  const want = pinsFor(names).map((p) => ({ name: p.split('==')[0], version: p.split('==')[1] })).filter((p) => !have.some((h) => h.name === p.name));
  if (args.includes('--dry-run')) {
    process.stderr.write(`Resolved ${want.length} packages\nWould install ${want.length} packages\n${want.map((p) => ` + ${p.name}==${p.version}`).join('\n')}\n`);
  } else {
    writeFileSync(installed(python), JSON.stringify([...have, ...want]));
    // as a real install leaves them: <name>-<version>.dist-info in site-packages
    for (const p of want) mkdirSync(join(envDir(python), 'Lib', 'site-packages', `${p.name.replace(/-/g, '_')}-${p.version}.dist-info`), { recursive: true });
  }
} else if (cmd === 'pip list') {
  const python = value('--python');
  process.stdout.write(existsSync(installed(python)) ? readFileSync(installed(python), 'utf8') : '[]');
} else {
  process.stderr.write(`fake uv: unknown command ${cmd}\n`);
  process.exit(2);
}
