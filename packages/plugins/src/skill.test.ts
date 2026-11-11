// The plugin-author skill (skills/spica-plugin-author) end to end, the way a
// company-side agent would use it: scaffold a plugin from nothing, check and
// pack it, install it into a running Spica through the MCP service (stdio and
// HTTP + token), have the agent call one of its tools (scripted fake model),
// disable it and see every tool withdrawn. Also: the packed zip passes the
// real plugin manager, and its page is served.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeGateway } from '../../core/src/testing/fake-gateway.ts';
import { installZip } from './sources.ts';
import { rig } from './testing/helpers.ts';

vi.setConfig({ testTimeout: 120_000 });

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SKILL = join(REPO, 'skills', 'spica-plugin-author', 'scripts');
const MCP_MAIN = join(REPO, 'packages', 'core', 'src', 'host', 'mcp-main.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

async function temp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** Run a skill script; resolves with exit code and output. */
function script(name: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(SKILL, name), ...args], { windowsHide: true, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    child.on('close', (code) => done({ code, out }));
  });
}

/** A fake model that calls `tool` once, then answers. */
async function gateway(tool: string): Promise<FakeGateway> {
  const gw = await new FakeGateway().start();
  cleanups.push(() => gw.stop());
  gw.onRequest((req) => {
    const messages = (req.body.messages ?? []) as { role: string }[];
    return messages.at(-1)?.role === 'tool' ? { text: 'Added it.' } : { toolCalls: [{ name: tool, args: { title: 'From the agent' } }] };
  });
  return gw;
}

async function backendConfig(dir: string, gw: FakeGateway): Promise<string> {
  const file = join(dir, 'backend.json');
  await writeFile(
    file,
    JSON.stringify({
      dbPath: join(dir, 'spica.db'),
      providers: [{ id: 'fake', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456' }],
      defaults: { providerId: 'fake', model: 'fake-model', maxTokens: 256, maxTurns: 4 },
      cwd: dir,
      extensions: [{ module: '@spica/plugins', options: { root: join(dir, 'plugins'), mock: true } }],
    }),
  );
  return file;
}

async function scaffoldAndPack(name: string, extra: string[] = []): Promise<string> {
  const parent = await temp('spica-skill-src-');
  const made = await script('scaffold.mjs', [name, '--dir', parent, ...extra]);
  expect(made.code, made.out).toBe(0);
  const checked = await script('check.mjs', [join(parent, name)]);
  expect(checked.code, checked.out).toBe(0);
  expect(checked.out).toMatch(/模拟模式下启动了，4 个工具/);
  expect(checked.out).toMatch(/测试全过/);
  const zip = join(parent, name, 'dist', `${name}-0.1.0.zip`);
  expect((await readFile(`${zip}.sha256`, 'utf8')).split(' ')[0]).toMatch(/^[0-9a-f]{64}$/);
  return zip;
}

describe('plugin-author skill', () => {
  it('scaffold → check → install over stdio → the agent uses it → disable withdraws everything', async () => {
    const zip = await scaffoldAndPack('shelf', ['--with', 'skill,command,hook']);
    const work = await temp('spica-skill-run-');
    const gw = await gateway('shelf__add_item');
    const cfg = await backendConfig(work, gw);

    const r = await script('install.mjs', [zip, '--stdio', cfg, '--spica', REPO, '--run', 'Add an item called From the agent.', '--disable-after']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/已安装「Shelf」0\.1\.0/);
    expect(r.out).toMatch(/新增工具：.*shelf__list_items.*shelf__remove_item/);
    expect(r.out).toMatch(/Agent 调了：shelf__add_item/);
    expect(r.out).toMatch(/停用后插件的工具全部撤掉了/);
    // The model saw the plugin's tools and its skill index.
    const first = JSON.stringify(gw.requests[0]?.body ?? {});
    expect(first).toContain('shelf__add_item');
    expect(first).toContain('shelf-basics');
  });

  it('install into a running Spica over HTTP: found through mcp-http.json, token from its file; a wrong token is refused plainly', async () => {
    const zip = await scaffoldAndPack('board', ['--with-ui']);
    const work = await temp('spica-skill-http-');
    const gw = await gateway('board__add_item');
    const cfg = await backendConfig(work, gw);
    const tokenFile = join(work, 'token.txt');
    const child: ChildProcess = spawn(process.execPath, [MCP_MAIN, '--config', cfg, '--http', '--port', '0', '--token-file', tokenFile], {
      cwd: REPO,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          if (child.exitCode !== null) return done();
          child.once('exit', () => done());
          child.kill();
        }),
    );
    const url = await new Promise<string>((done, fail) => {
      const t = setTimeout(() => fail(new Error('MCP HTTP service did not start')), 60_000);
      createInterface({ input: child.stderr! }).on('line', (line) => {
        const m = /MCP over HTTP at (\S+)/.exec(line);
        if (m) {
          clearTimeout(t);
          done(m[1]!);
        }
      });
    });

    const bad = join(work, 'bad-token.txt');
    await writeFile(bad, 'x'.repeat(40));
    const refused = await script('install.mjs', [zip, '--http', url, '--token-file', bad]);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/令牌不对/);

    // Default connection: the file a running desktop Spica writes when its local MCP connection is on.
    const userData = join(work, 'user-data');
    const none = await script('install.mjs', [zip], { SPICA_USER_DATA: userData });
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/没找到正在运行、而且开了本机连接的 Spica[\s\S]*设置 › 插件/);
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, 'mcp-http.json'), JSON.stringify({ url, tokenFile, pid: 2 ** 30, startedAt: new Date().toISOString() }));
    expect((await script('install.mjs', [zip], { SPICA_USER_DATA: userData })).out).toMatch(/现在没在运行/);
    await writeFile(join(userData, 'mcp-http.json'), JSON.stringify({ url, tokenFile, pid: child.pid, startedAt: new Date().toISOString() }));

    const r = await script('install.mjs', [zip, '--run', 'Add an item.', '--disable-after'], { SPICA_USER_DATA: userData });
    expect(r.out).toMatch(/连接正在运行的 Spica/);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/页面：Board（sidebar）/);
    expect(r.out).toMatch(/Agent 调了：board__add_item/);
    expect(r.out).toMatch(/停用后插件的工具全部撤掉了/);

    // A build packaged under another name keeps its folder under <appData>/<name>.
    const appData = join(work, 'app-data');
    const perUser = process.platform === 'darwin' ? join(appData, 'Library', 'Application Support') : appData;
    const env = { SPICA_USER_DATA: '', APPDATA: appData, XDG_CONFIG_HOME: appData, HOME: appData };
    const renamed = join(perUser, 'Acme Desk');
    await mkdir(renamed, { recursive: true });
    const info = (pid: number) => JSON.stringify({ appName: 'Acme Desk', url, tokenFile, pid, startedAt: new Date().toISOString() });
    await writeFile(join(renamed, 'mcp-http.json'), info(2 ** 30));
    const stale = await script('install.mjs', [zip, '--app', 'Acme Desk'], env);
    expect(stale.out).toMatch(/Acme Desk 上次开过本机连接，但现在没在运行[\s\S]*在 Acme Desk 的 设置 › 常规 › 开发者 里打开「允许本机脚本连接 Acme Desk」/);
    expect((await script('install.mjs', [zip, '--user-data', renamed, '--app', 'Other Desk'], env)).out).toMatch(/是「Acme Desk」写的，不是你说的「Other Desk」/);
    await writeFile(join(renamed, 'mcp-http.json'), info(child.pid!));
    // No --app: the one running renamed copy is found.
    const found = await script('install.mjs', [zip, '--no-enable'], env);
    expect(found.out).toMatch(/连接正在运行的 Acme Desk/);
    // Two running copies: asks which one.
    await mkdir(join(perUser, 'Beta Desk'), { recursive: true });
    await writeFile(join(perUser, 'Beta Desk', 'mcp-http.json'), info(child.pid!).replace('Acme Desk', 'Beta Desk'));
    expect((await script('install.mjs', [zip], env)).out).toMatch(/有好几个应用开着本机连接：(Acme Desk、Beta Desk|Beta Desk、Acme Desk)。用 --app/);
  });

  it('the packed zip passes the real plugin manager, and its page can call its tools', async () => {
    const zip = await scaffoldAndPack('panel-demo', ['--placement', 'panel']);
    const r = await rig();
    cleanups.push(() => r.cleanup());
    await r.pm.setMock(true);
    const d = await installZip(r.pm, await readFile(zip), { kind: 'zip', location: zip });
    expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(d.views).toMatchObject([{ id: 'main', entry: 'ui/index.html', placement: 'panel' }]);
    await r.pm.enable('panel-demo');
    expect(r.pm.views()[0]).toMatchObject({ tools: ['list_items', 'add_item', 'remove_item'], irreversible: ['remove_item'] });
    expect(await r.pm.resolveViewFile('panel-demo', 'ui/app.js')).toBeTruthy();
    const listed = await r.pm.viewCall('panel-demo', 'main', 'list_items');
    expect(listed).toMatchObject({ isError: false, data: { total: 3 } });
    expect((await r.pm.viewCall('panel-demo', 'main', 'get_item', { id: 'item-001' })).content).toMatch(/^\[TOOL_NOT_ALLOWED\]/);
    expect((await r.pm.viewCall('panel-demo', 'main', 'remove_item', { id: 'item-001' })).content).toMatch(/^\[CONFIRM_REQUIRED\]/);
  });

  it('check explains what to fix and does not pack', async () => {
    const parent = await temp('spica-skill-bad-');
    expect((await script('scaffold.mjs', ['Bad_Name', '--dir', parent])).out).toMatch(/插件名只能用小写字母/);
    await script('scaffold.mjs', ['leaky', '--dir', parent]);
    const root = join(parent, 'leaky');
    const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { permissions: { irreversible: string[] } };
    m.permissions.irreversible.push('drop_everything');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(m));
    await writeFile(join(root, 'server', 'config.js'), `export const apiKey = "${'sk-'}${'a'.repeat(32)}";\n`);
    const r = await script('check.mjs', [root]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/server\/config\.js：里面有像模型 API key 的字符串/);
    expect(r.out).not.toMatch(/已打包/);
    await rm(join(root, 'server', 'config.js'));
    const r2 = await script('check.mjs', [root]);
    expect(r2.out).toMatch(/permissions\.irreversible 里的 drop_everything 不是任何 server 的工具/);
  });

  it('check: the plugin icon is an .svg in the folder, up to 64 KB; scripts and links in it are pointed out; none is a hint', async () => {
    const parent = await temp('spica-skill-icon-');
    await script('scaffold.mjs', ['shiny', '--dir', parent]);
    const root = join(parent, 'shiny');
    const setIcon = async (icon: string | undefined) => {
      const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      if (icon === undefined) delete m.icon;
      else m.icon = icon;
      await writeFile(join(root, 'manifest.json'), JSON.stringify(m));
    };
    const run = () => script('check.mjs', [root, '--no-tests', '--no-pack']);
    // The scaffold gives one, so nothing is said.
    expect((await run()).out).not.toMatch(/icon/);
    await setIcon('missing.svg');
    expect((await run()).out).toMatch(/manifest\.json：icon 要指向插件文件夹里存在的 \.svg/);
    await writeFile(join(root, 'big.svg'), `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(70 * 1024)}</svg>`);
    await setIcon('big.svg');
    expect((await run()).out).toMatch(/icon 文件不能大于 64 KB（当前 71 KB）/);
    await writeFile(join(root, 'busy.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script></svg>');
    await setIcon('busy.svg');
    const busy = await run();
    expect(busy.out).toMatch(/icon 里有脚本、事件属性或外部链接/);
    expect(busy.code, busy.out).toBe(0);
    await setIcon(undefined);
    expect((await run()).out).toMatch(/没有 icon，插件列表里会用名字的第一个字代替/);
    // One for each skin: each is checked and named.
    const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    m.icon = { light: 'icon-light.svg', dark: 'gone.svg' };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(m));
    expect((await run()).out).toMatch(/manifest\.json：icon\.dark 要指向插件文件夹里存在的 \.svg/);
    m.icon = { light: 'icon-light.svg' };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(m));
    expect((await run()).out).toMatch(/浅色和深色各一款时写 \{ "light": "icon-light\.svg", "dark": "icon-dark\.svg" \}/);
  });

  it('check warns about environment variables a plugin will not get once installed', async () => {
    const parent = await temp('spica-skill-env-');
    await script('scaffold.mjs', ['envy', '--dir', parent]);
    const root = join(parent, 'envy');
    await writeFile(
      join(root, 'server', 'config.js'),
      [
        'export const token = process.env.EXAMPLE_API_TOKEN;',
        "export const base = process.env['EXAMPLE_BASE_URL'];",
        'export const own = process.env.OWN_SETTING;',
        'export const data = process.env.SPICA_PLUGIN_DATA;',
        'export const proxy = process.env.HTTPS_PROXY;',
        'export const pc = process.env.COMPUTERNAME;',
        'export const user = process.env.USERNAME;',
        '',
      ].join('\n'),
    );
    await writeFile(join(root, 'mcp', 'envy.json'), JSON.stringify({ runtime: 'node', entry: 'server/index.js', env: { OWN_SETTING: 'x' } }));
    const r = await script('check.mjs', [root, '--no-tests', '--no-pack']);
    expect(r.out).toMatch(/server\/config\.js：读环境变量 EXAMPLE_API_TOKEN：装进 Spica 后读不到（只传白名单变量，带 KEY、TOKEN、SECRET 的一律不传）/);
    expect(r.out).toMatch(/读环境变量 EXAMPLE_BASE_URL：装进 Spica 后读不到（只传白名单变量：PATH、TEMP、用户目录、COMPUTERNAME、USERNAME 这类，全表见作者指南第 2 节）。要用就写进 mcp\/<id>\.json 的 env/);
    expect(r.out).not.toMatch(/读环境变量 (OWN_SETTING|SPICA_PLUGIN_DATA|HTTPS_PROXY|COMPUTERNAME|USERNAME)/);
    expect(r.code, r.out).toBe(0);
  });
});
