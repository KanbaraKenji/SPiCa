// Files an MCP tool returns inside its result (EmbeddedResource with a blob): kept for the user where they work,
// a card for each, one line for the model and never the bytes; bad input never fails the call or writes outside.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { makeRuntime, startGateway } from '../testing/helpers.ts';
// @ts-expect-error a plain script beside the tests
import { startFakeMcpHttp } from '../testing/fake-mcp-http.mjs';
import { McpStdioClient } from './client.ts';
import { base64Size, EMBEDDED_LIMIT, embeddedName, keepEmbedded, nameFromUri, safeName } from './embedded.ts';

vi.setConfig({ testTimeout: 60_000 });

// `make` answers with the content items it is given; `big` with one file of `bytes` zero bytes (made there, so the
// test does not send it)
const SERVER = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'dl' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [{ name: 'make', inputSchema: { type: 'object' } }, { name: 'big', inputSchema: { type: 'object' } }] } });
  if (m.params.name === 'big') {
    const blob = Buffer.alloc(m.params.arguments.bytes).toString('base64');
    return send({ id: m.id, result: { content: [{ type: 'resource', resource: { uri: 'file:///out/big.bin', mimeType: 'application/octet-stream', blob } }] } });
  }
  return send({ id: m.id, result: { content: m.params.arguments.content } });
});
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spica-embedded-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const blob = (uri: string, data: string, mimeType?: string) => ({ type: 'resource', resource: { uri, ...(mimeType ? { mimeType } : {}), blob: data } });

describe('the name a kept file gets', () => {
  it('the uri’s last part, without query or fragment, percent-decoded', () => {
    expect(nameFromUri('file:///x/spec.pdf')).toBe('spec.pdf');
    expect(nameFromUri('https://example.com/files/BOM%20v2.xlsx?sig=abc#top')).toBe('BOM v2.xlsx');
    expect(nameFromUri('file:///C:/out/%E6%8A%A5%E5%91%8A.pdf')).toBe('报告.pdf');
    expect(nameFromUri('spec.pdf')).toBe('spec.pdf');
    expect(nameFromUri('urn:example:report.pdf')).toBe('example_report.pdf');
  });

  it('never a path: .., drive letters, back slashes, encoded separators', () => {
    expect(nameFromUri('file:///x/../../etc/passwd')).toBe('passwd');
    expect(nameFromUri('file:///x/..')).toBe('');
    expect(nameFromUri('file:///x/%2e%2e%2f%2e%2e%2fwin.ini')).toBe('win.ini');
    expect(nameFromUri('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(nameFromUri('file:///x/a%5cb%5cc.txt')).toBe('c.txt');
    expect(nameFromUri('D:')).toBe('');
    expect(nameFromUri('file:///x/')).toBe('');
  });

  it('characters Windows refuses, device names, trailing dots and spaces, long names', () => {
    expect(safeName('a:b*c?"d<e>|f.txt')).toBe('a_b_c__d_e__f.txt');
    expect(safeName('report.pdf:hidden')).toBe('report.pdf_hidden');
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('nul.txt')).toBe('_nul.txt');
    expect(safeName('COM1.pdf')).toBe('_COM1.pdf');
    expect(safeName('name. . ')).toBe('name');
    expect(safeName('tab\there')).toBe('tab_here');
    const long = safeName(`${'很'.repeat(300)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('the mime type adds an extension only when the name has none; a missing one or a mismatch keeps the name', () => {
    expect(embeddedName('file:///x/spec', 'application/pdf')).toBe('spec.pdf');
    expect(embeddedName('file:///x/bom', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary')).toBe('bom.xlsx');
    expect(embeddedName('file:///x/spec.pdf', 'text/plain')).toBe('spec.pdf');
    expect(embeddedName('file:///x/data', undefined)).toBe('data');
    expect(embeddedName('', 'application/pdf')).toBe('file.pdf');
    expect(embeddedName('file:///x/..', undefined)).toBe('file');
  });
});

describe('base64', () => {
  it('its decoded size; not base64 (bad characters, wrong length, padding inside): undefined', () => {
    expect(base64Size(b64('hello'))).toBe(5);
    expect(base64Size(b64('hell'))).toBe(4);
    expect(base64Size('')).toBe(0);
    expect(base64Size('aGVs\nbG8=')).toBe(5); // line breaks are allowed
    expect(base64Size('aGVsbG8')).toBeUndefined();
    expect(base64Size('aGV$bG8=')).toBeUndefined();
    expect(base64Size('aG=sbG8=')).toBeUndefined();
    expect(base64Size('aGVsbG8-_w==')).toBeUndefined(); // base64url is not base64
  });
});

describe('keepEmbedded', () => {
  it('writes the bytes in the folder, never over a file: name (2).ext, (3), ...', () => {
    writeFileSync(join(dir, 'spec.pdf'), 'old');
    const a = keepEmbedded(dir, { uri: 'file:///x/spec.pdf', blob: b64('%PDF-1') });
    const b = keepEmbedded(dir, { uri: 'file:///y/spec.pdf', blob: b64('%PDF-2') });
    expect(a).toEqual({ ok: true, path: join(dir, 'spec (2).pdf'), bytes: 6 });
    expect(b).toEqual({ ok: true, path: join(dir, 'spec (3).pdf'), bytes: 6 });
    expect(readFileSync(join(dir, 'spec.pdf'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'spec (3).pdf'), 'utf8')).toBe('%PDF-2');
  });

  it('a name differing only in case is taken too (Windows, macOS)', () => {
    writeFileSync(join(dir, 'Spec.PDF'), 'old');
    const a = keepEmbedded(dir, { uri: 'spec.pdf', blob: b64('new') });
    if (process.platform === 'win32' || process.platform === 'darwin') expect(a).toMatchObject({ path: join(dir, 'spec (2).pdf') });
    expect(readFileSync(join(dir, 'Spec.PDF'), 'utf8')).toBe('old');
  });

  it('over the limit: not decoded, not written; not base64: not written', () => {
    const big = 'A'.repeat(4 * Math.ceil((EMBEDDED_LIMIT + 1) / 3));
    expect(keepEmbedded(dir, { uri: 'big.bin', blob: big })).toMatchObject({ ok: false, reason: 'too_large', name: 'big.bin' });
    expect(keepEmbedded(dir, { uri: 'x.pdf', blob: 'not base64!' })).toEqual({ ok: false, reason: 'bad_data', name: 'x.pdf' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a folder it cannot write in: write_failed with the reason, nothing half-written', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const r = keepEmbedded(join(file, 'sub'), { uri: 'x.pdf', blob: b64('x') });
    expect(r).toMatchObject({ ok: false, reason: 'write_failed', name: 'x.pdf' });
  });

  it('whatever the uri, the file lands in the folder', () => {
    const inner = join(dir, 'work');
    mkdirSync(inner);
    for (const uri of ['file:///x/../../../escape.txt', '..\\..\\escape2.txt', 'file:///x/%2e%2e%5c%2e%2e%5cescape3.txt', 'C:\\escape4.txt', '/etc/escape5.txt'])
      expect(keepEmbedded(inner, { uri, blob: b64('x') })).toMatchObject({ ok: true });
    expect(readdirSync(dir)).toEqual(['work']);
    expect(readdirSync(inner).sort()).toEqual(['escape.txt', 'escape2.txt', 'escape3.txt', 'escape4.txt', 'escape5.txt']);
  });
});

describe('embedded files in MCP tool results', () => {
  it('kept, one line each for the model (no base64); text with the file goes to the model; text alone as before', async () => {
    const c = new McpStdioClient({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const pdf = b64('%PDF-1.4 spec');
      const r = await c.callTool(
        'make',
        {
          content: [
            { type: 'text', text: 'made 2 files' },
            blob('file:///srv/out/spec.pdf', pdf, 'application/pdf'),
            { type: 'resource', resource: { uri: 'file:///srv/out/bom', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', blob: b64('PK'), text: 'BOM: 3 rows' } },
            { type: 'resource', resource: { uri: 'file:///srv/notes.md', text: '# notes' } },
            { type: 'resource', resource: { uri: 'file:///srv/x' } },
          ],
        },
        undefined,
        undefined,
        undefined,
        (res) => keepEmbedded(dir, res),
      );
      expect(r.isError).toBe(false);
      expect(r.content.split('\n')).toEqual(['made 2 files', `文件：${join(dir, 'spec.pdf')}`, 'BOM: 3 rows', `文件：${join(dir, 'bom.xlsx')}`, '# notes', '[resource file:///srv/x]']);
      expect(r.content).not.toContain(pdf);
      expect(r.files).toEqual([join(dir, 'spec.pdf'), join(dir, 'bom.xlsx')]);
      expect(readFileSync(join(dir, 'spec.pdf'), 'utf8')).toBe('%PDF-1.4 spec');
    } finally {
      await c.close();
    }
  });

  it('bad ones are told and listed, the good ones kept, the call is not an error; many with one name all kept', async () => {
    const c = new McpStdioClient({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const many = Array.from({ length: 30 }, (_, i) => blob('file:///srv/part.csv', b64(`row ${i}`), 'text/csv'));
      const r = await c.callTool(
        'make',
        { content: [blob('file:///srv/bad.pdf', '%%%not base64', 'application/pdf'), blob('file:///srv/../../evil.bat', b64('@echo off')), ...many] },
        undefined,
        undefined,
        undefined,
        (res) => keepEmbedded(dir, res),
      );
      expect(r.isError).toBe(false);
      const lines = r.content.split('\n');
      expect(lines[0]).toBe('文件 bad.pdf 没有保存：内容不是有效的 base64');
      expect(lines[1]).toBe(`文件：${join(dir, 'evil.bat')}`);
      expect(r.notKept).toEqual([{ name: 'bad.pdf', reason: 'bad_data' }]);
      expect(r.files).toHaveLength(31);
      expect(readdirSync(dir)).toHaveLength(31);
      expect(existsSync(join(dir, 'part (30).csv'))).toBe(true);
    } finally {
      await c.close();
    }
  });

  it('just over the limit over a local program: one line, nothing written; just under: kept (a message of about 67 MB)', async () => {
    const c = new McpStdioClient({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const over = await c.callTool('big', { bytes: EMBEDDED_LIMIT + 1 }, undefined, undefined, undefined, (res) => keepEmbedded(dir, res));
      expect(over.isError).toBe(false);
      expect(over.content).toBe('文件 big.bin 没有保存：超过 50 MB 的上限（50.0 MB）');
      expect(over.notKept).toEqual([{ name: 'big.bin', reason: 'too_large', bytes: EMBEDDED_LIMIT + 1 }]);
      expect(readdirSync(dir)).toEqual([]);
      const t0 = Date.now();
      const under = await c.callTool('big', { bytes: EMBEDDED_LIMIT }, undefined, undefined, undefined, (res) => keepEmbedded(dir, res));
      expect(under.content).toBe(`文件：${join(dir, 'big.bin')}`);
      expect(readFileSync(join(dir, 'big.bin')).length).toBe(EMBEDDED_LIMIT);
      expect(Date.now() - t0).toBeLessThan(30_000);
    } finally {
      await c.close();
    }
  });

  it('with no place to keep it (no keepFile: a plugin page’s call), one line saying so', async () => {
    const c = new McpStdioClient({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const r = await c.callTool('make', { content: [blob('file:///srv/spec.pdf', b64('x'), 'application/pdf')] });
      expect(r.content).toBe('文件 spec.pdf 没有保存：这次调用不在对话里，没有地方存');
      expect(r.notKept).toEqual([{ name: 'spec.pdf', reason: 'no_folder' }]);
    } finally {
      await c.close();
    }
  });
});

describe('where a conversation keeps them, and their cards', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  const run = async (opts: { cwd?: string; project?: boolean; child?: boolean }) => {
    const legacy = join(dir, 'legacy');
    mkdirSync(legacy, { recursive: true });
    const rt = makeRuntime(gw, { sessionFilesDir: join(dir, 'app', 'sessions'), mediaDir: join(dir, 'app', 'media'), cwd: join(dir, 'default'), legacyDefaultCwd: legacy });
    const content = [blob('file:///srv/spec.pdf', b64('%PDF'), 'application/pdf'), blob('file:///srv/huge.bin', 'A'.repeat(4 * Math.ceil((EMBEDDED_LIMIT + 1) / 3)))];
    gw.enqueue({ toolCalls: [{ id: 'e1', name: 'dl__make', args: { content } }] }, { text: 'done' });
    try {
      await rt.connectMcp({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
      const projectFolder = join(dir, 'project');
      mkdirSync(projectFolder, { recursive: true });
      const projectId = opts.project ? rt.createProject({ name: 'p', folder: projectFolder }).id : undefined;
      // in a project, still in the folder all conversations shared in earlier versions
      const top = rt.createSession({ ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(projectId ? { projectId, cwd: legacy } : {}) });
      const s = opts.child ? rt.createSession({ parentId: top.id }) : top;
      const cards: { path: string; origin?: string; notSaved?: string; sizeBytes: number }[] = [];
      rt.events.on((e) => {
        if (e.type === 'file.card') cards.push(...((e as unknown as { files: never[] }).files ?? []));
      });
      await s.send('make the spec').done;
      // what the model reads of the call (its arguments here carry the file: the fake server echoes them)
      const told = JSON.stringify(s.messages().flatMap((m) => m.content).filter((b) => b.type === 'tool_result'));
      const kept = s.messages().find((m) => m.meta?.fileCardLists)?.meta?.fileCardLists?.e1;
      return { s, cards, told, kept, projectFolder, ownFolder: rt.ownFolder(top.id)!, media: rt.mediaDir(s.id), legacy };
    } finally {
      await rt.close();
    }
  };

  it('a working folder the user chose: kept there, a card for it and one saying why the other was not kept', async () => {
    const work = join(dir, 'work');
    mkdirSync(work);
    const { cards, told, kept } = await run({ cwd: work });
    expect(readFileSync(join(work, 'spec.pdf'), 'utf8')).toBe('%PDF');
    expect(cards.map((c) => [c.path, c.origin, c.notSaved])).toEqual([
      [join(work, 'spec.pdf'), 'produced', undefined],
      ['e1/1/huge.bin', 'produced', 'too_large'],
    ]);
    expect(cards[1]!.sizeBytes).toBe(EMBEDDED_LIMIT + 1);
    expect(existsSync(join(work, 'huge.bin'))).toBe(false);
    expect(kept?.map((c) => c.notSaved)).toEqual([undefined, 'too_large']); // kept with the conversation (history)
    expect(told).not.toContain(b64('%PDF'));
  });

  it('none chosen: the media folder, not the folder the app gave it; a sub-agent of it the same', async () => {
    for (const child of [false, true]) {
      const r = await run({ child });
      expect(existsSync(r.ownFolder) ? readdirSync(r.ownFolder) : []).toEqual([]);
      expect(readFileSync(join(r.media, 'spec.pdf'), 'utf8')).toBe('%PDF');
      expect(existsSync(join(dir, 'default'))).toBe(false);
    }
  });

  it('one name kept and one not in the same call: both cards, kept with the conversation; a plugin page: one line, no file', async () => {
    const work = join(dir, 'work2');
    mkdirSync(work);
    const rt = makeRuntime(gw, { sessionFilesDir: join(dir, 'app', 'sessions'), mediaDir: join(dir, 'app', 'media'), cwd: join(dir, 'default') });
    const content = [blob('file:///srv/report.pdf', b64('%PDF')), blob('file:///other/report.pdf', '%%bad')];
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'dl__make', args: { content } }] }, { text: 'done' });
    try {
      await rt.connectMcp({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
      const s = rt.createSession({ cwd: work });
      await s.send('make the report').done;
      const kept = s.messages().find((m) => m.meta?.fileCardLists)?.meta?.fileCardLists?.r1;
      expect(kept?.map((c) => [c.path, c.name, c.notSaved])).toEqual([
        [join(work, 'report.pdf'), 'report.pdf', undefined],
        ['r1/1/report.pdf', 'report.pdf', 'bad_data'],
      ]);
      await rt.connectMcp({ name: 'pl', command: process.execPath, args: ['-e', SERVER] }, { source: 'plugin:pl' });
      const r = await rt.callPluginTool('pl', 'make', { content: [blob('file:///srv/page.pdf', b64('%PDF'))] });
      expect(r).toMatchObject({ isError: false, content: '文件 page.pdf 没有保存：这次调用不在对话里，没有地方存' });
      expect(existsSync(join(dir, 'default'))).toBe(false);
    } finally {
      await rt.close();
    }
  });

  it('in a project with a folder, none chosen: the project’s folder', async () => {
    const r = await run({ project: true });
    expect(readFileSync(join(r.projectFolder, 'spec.pdf'), 'utf8')).toBe('%PDF');
    expect(readdirSync(r.legacy)).toEqual([]);
  });
});

describe('the test service that hands files over (fake-mcp-files.mjs): a local program and a web address', () => {
  const files = fileURLToPath(new URL('../testing/fake-mcp-files.mjs', import.meta.url));

  it('a local program: the PDF and the Excel file, kept with their names', async () => {
    const c = new McpStdioClient({ name: 'files', command: process.execPath, args: [files], protocol: 'auto' });
    await c.connect();
    try {
      const r = await c.callTool('export_documents', { product: 'PSU-200' }, undefined, undefined, undefined, (res) => keepEmbedded(dir, res));
      expect(r.content.split('\n')).toEqual(['Exported 2 files for PSU-200.', `文件：${join(dir, 'PSU-200-spec.pdf')}`, `文件：${join(dir, 'PSU-200-BOM.xlsx')}`]);
      expect(readFileSync(join(dir, 'PSU-200-spec.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
      expect(readFileSync(join(dir, 'PSU-200-BOM.xlsx')).subarray(0, 2).toString()).toBe('PK');
    } finally {
      await c.close();
    }
  });

  for (const era of ['modern', 'legacy', 'sse'] as const) {
    it(`at a web address (${era}): the files; just over the limit told, just under kept`, async () => {
      const server = await startFakeMcpHttp({ era, files: true });
      const c = new McpStdioClient({ name: 'files', command: '', url: server.url as string, protocol: 'auto' });
      try {
        await c.connect();
        const keep = (res: { uri?: unknown; mimeType?: unknown; blob: string }) => keepEmbedded(dir, res);
        const r = await c.callTool('export_documents', { product: 'PSU-200' }, undefined, undefined, undefined, keep);
        expect(r.files).toEqual([join(dir, 'PSU-200-spec.pdf'), join(dir, 'PSU-200-BOM.xlsx')]);
        const over = await c.callTool('export_documents', { product: 'PSU-200', bytes: EMBEDDED_LIMIT + 1 }, undefined, undefined, undefined, keep);
        expect(over.notKept).toEqual([{ name: 'PSU-200-archive.bin', reason: 'too_large', bytes: EMBEDDED_LIMIT + 1 }]);
        const t0 = Date.now();
        const under = await c.callTool('export_documents', { product: 'PSU-200', bytes: EMBEDDED_LIMIT }, undefined, undefined, undefined, keep);
        expect(under.files).toEqual([join(dir, 'PSU-200-archive.bin')]);
        expect(readFileSync(join(dir, 'PSU-200-archive.bin')).length).toBe(EMBEDDED_LIMIT);
        expect(Date.now() - t0).toBeLessThan(30_000);
      } finally {
        await c.close();
        await server.close();
      }
    });
  }
});
