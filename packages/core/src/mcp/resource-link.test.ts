// MCP tools that produce files: resource_link items with a file:// URI of a local file get a
// file card (file.card with every card of the call, meta.fileCardLists), and the model reads one
// line per link instead of "[resource_link omitted]".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { makeRuntime, startGateway } from '../testing/helpers.ts';
import { McpStdioClient } from './client.ts';

vi.setConfig({ testTimeout: 30_000 });

// `make` answers with the content items it is given; `env`-free and dependency-free.
const SERVER = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'dl' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [{ name: 'make', inputSchema: { type: 'object' } }] } });
  return send({ id: m.id, result: { content: m.params.arguments.content } });
});
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spica-links-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const link = (uri: string, name = 'f', mimeType?: string) => ({ type: 'resource_link', uri, name, ...(mimeType ? { mimeType } : {}) });

describe('resource_link in MCP tool results', () => {
  it('each link becomes one line for the model; only existing local files are listed as files', async () => {
    const pdf = join(dir, 'demo.pdf');
    writeFileSync(pdf, '%PDF-1.4');
    const spaced = join(dir, '报告 2026 年.xlsx'); // spaces and Chinese
    writeFileSync(spaced, 'x');
    const sub = join(dir, 'folder');
    mkdirSync(sub);
    const c = new McpStdioClient({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const r = await c.callTool('make', {
        content: [
          { type: 'text', text: 'saved 2 files' },
          link(pathToFileURL(pdf).href, 'demo.pdf', 'application/pdf'),
          link(pathToFileURL(spaced).href, 'report'),
          link(pathToFileURL(sub).href, 'folder'),
          link(pathToFileURL(join(dir, 'missing.pdf')).href, 'missing.pdf'),
          link('https://example.com/a.pdf', 'a.pdf'),
        ],
      });
      expect(r.content).not.toMatch(/omitted/);
      expect(r.content.split('\n')).toEqual([
        'saved 2 files',
        `文件：${pdf}`,
        `文件：${spaced}`,
        `文件夹：${sub}`,
        `文件（不存在）：${join(dir, 'missing.pdf')}`,
        '链接：https://example.com/a.pdf',
      ]);
      expect(r.files).toEqual([pdf, spaced]);
    } finally {
      await c.close();
    }
  });

  it.runIf(process.platform === 'win32')('Windows drive letters and UNC paths become local paths', async () => {
    const { fileURLToPath } = await import('node:url');
    // what fileURLToPath gives for the shapes plugins send
    expect(fileURLToPath('file:///D:/tmp/demo.pdf')).toBe('D:\\tmp\\demo.pdf');
    expect(fileURLToPath('file://server/share/a%20b.pdf')).toBe('\\\\server\\share\\a b.pdf');
    expect(fileURLToPath('file:///D:/%E6%8A%A5%E5%91%8A.pdf')).toBe('D:\\报告.pdf');
  });
});

describe('file cards for produced files', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('a call that produced several files gets a card for each, in order; the first stays in fileCards', async () => {
    const pdf = join(dir, 'demo.pdf');
    writeFileSync(pdf, '%PDF-1.4');
    const zip = join(dir, 'parts.zip');
    writeFileSync(zip, 'PK');
    const content = [{ type: 'text', text: 'done' }, link(pathToFileURL(pdf).href, 'demo.pdf'), link(pathToFileURL(zip).href, 'parts.zip')];
    gw.enqueue({ toolCalls: [{ id: 'd1', name: 'dl__make', args: { content } }] }, { text: 'here they are' });
    const rt = makeRuntime(gw);
    try {
      await rt.connectMcp({ name: 'dl', command: process.execPath, args: ['-e', SERVER] });
      const s = rt.createSession();
      const events: { type: string; files?: { path: string; kind: string; origin?: string }[]; file?: { path: string } }[] = [];
      rt.events.on((e) => {
        if (e.type === 'file.card') events.push(e as never);
      });
      await s.send('download them').done;
      expect(events).toHaveLength(1);
      expect(events[0]!.file!.path).toBe(pdf);
      expect(events[0]!.files!.map((f) => [f.path, f.kind, f.origin])).toEqual([
        [pdf, 'pdf', 'produced'],
        [zip, 'other', 'produced'],
      ]);
      const results = s.messages().find((m) => m.meta?.fileCardLists);
      expect(results?.meta?.fileCards?.d1?.path).toBe(pdf);
      expect(results?.meta?.fileCardLists?.d1?.map((f) => f.path)).toEqual([pdf, zip]);
      const card = results!.meta!.fileCardLists!.d1![1]!;
      expect(card).toMatchObject({ name: 'parts.zip', sizeBytes: 2, read: {}, origin: 'produced' });
      expect(JSON.stringify(results!.content)).toContain(`文件：${zip.replace(/\\/g, '\\\\')}`);
    } finally {
      await rt.close();
    }
  });

  it('a plugin page gets the same lines, and no card', async () => {
    const pdf = join(dir, 'demo.pdf');
    writeFileSync(pdf, '%PDF-1.4');
    const rt = makeRuntime(gw);
    try {
      await rt.connectMcp({ name: 'dl', command: process.execPath, args: ['-e', SERVER] }, { source: 'plugin:dl' });
      const r = await rt.callPluginTool('dl', 'make', { content: [link(pathToFileURL(pdf).href, 'demo.pdf')] });
      expect(r).toMatchObject({ isError: false, content: `文件：${pdf}` });
    } finally {
      await rt.close();
    }
  });
});
