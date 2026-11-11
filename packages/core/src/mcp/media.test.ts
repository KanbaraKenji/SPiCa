// Images, audio and structured results from MCP tools: images and audio are kept as files in
// the conversation's media folder (a card each; deleted with the conversation), images go to the
// model after the results, and structured results reach the model once.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { makeRuntime, startGateway } from '../testing/helpers.ts';
import { McpStdioClient } from './client.ts';
import { toAnthropicMessages } from '../providers/anthropic.ts';
import { keepMedia } from './media.ts';

vi.setConfig({ testTimeout: 30_000 });

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WAV = Buffer.from('RIFF0000WAVEfmt ').toString('base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');

// `make` answers with the content (and structuredContent) it is given
const SERVER = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'pic' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [
    { name: 'make', title: 'Make a picture', inputSchema: { type: 'object' } },
    { name: 'old', annotations: { title: 'Old-style title' }, inputSchema: { type: 'object' } },
  ] } });
  const a = m.params.arguments;
  return send({ id: m.id, result: { content: a.content ?? [], ...(a.structured ? { structuredContent: a.structured } : {}) } });
});
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spica-media-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('images and audio from an MCP tool', () => {
  it('kept as files: a line each for the model, the image also as a block for the model', async () => {
    const c = new McpStdioClient({ name: 'pic', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const keep = (kind: 'image' | 'audio', data: string, type: string) => keepMedia(dir, kind, data, type);
      const r = await c.callTool(
        'make',
        {
          content: [
            { type: 'text', text: 'chart ready' },
            { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
            { type: 'audio', data: WAV, mimeType: 'audio/wav' },
            { type: 'image', data: SVG, mimeType: 'image/svg+xml' },
          ],
        },
        undefined,
        undefined,
        keep,
      );
      const lines = r.content.split('\n');
      expect(lines[0]).toBe('chart ready');
      expect(lines[1]).toMatch(/^图片：.+\.png$/);
      expect(lines[2]).toMatch(/^音频：.+\.wav（模型听不到内容）$/);
      expect(lines[3]).toMatch(/^图片：.+\.svg（格式或大小不合适，没有发给模型）$/);
      expect(r.content).not.toMatch(/omitted/);
      expect(r.files).toHaveLength(3);
      expect(r.files!.every((f) => f.startsWith(dir) && existsSync(f))).toBe(true);
      expect(r.images).toEqual([{ type: 'image', path: r.files![0], mediaType: 'image/png', width: 1, height: 1, bytes: expect.any(Number) }]);
    } finally {
      await c.close();
    }
  });

  it('without a place to keep them (a plugin page calling directly) they are left out as before', async () => {
    const c = new McpStdioClient({ name: 'pic', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const r = await c.callTool('make', { content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }] });
      expect(r).toEqual({ content: '[image image/png omitted]', isError: false });
    } finally {
      await c.close();
    }
  });

  it('structured results: the text is what the model reads; structuredContent alone when there is nothing else', async () => {
    const c = new McpStdioClient({ name: 'pic', command: process.execPath, args: ['-e', SERVER] });
    await c.connect();
    try {
      const structured = { temperature: 22.5, sky: 'clear' };
      // as the spec asks: the same JSON as text -> the text, not repeated
      const same = await c.callTool('make', { content: [{ type: 'text', text: '{ "sky": "clear", "temperature": 22.5 }' }], structured });
      expect(same.content).toBe('{ "sky": "clear", "temperature": 22.5 }');
      // a wrapped result ({ value }) said differently in the text -> the text only
      const wrapped = await c.callTool('make', { content: [{ type: 'text', text: '[1, 2]' }], structured: { value: [1, 2] } });
      expect(wrapped.content).toBe('[1, 2]');
      // nothing else -> the data
      const alone = await c.callTool('make', { structured });
      expect(alone.content).toBe(JSON.stringify(structured));
    } finally {
      await c.close();
    }
  });
});

describe('images from an MCP tool in a conversation', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('go to the model after the results, get a card, and are deleted with the conversation', async () => {
    const content = [{ type: 'text', text: 'here' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }];
    gw.enqueue({ toolCalls: [{ id: 'p1', name: 'pic__make', args: { content } }] }, { text: 'I see a dot' });
    const rt = makeRuntime(gw);
    try {
      await rt.connectMcp({ name: 'pic', command: process.execPath, args: ['-e', SERVER] });
      expect(rt.tools.get('pic__make')?.title).toBe('Make a picture');
      expect(rt.tools.get('pic__old')?.title).toBe('Old-style title');
      const cards: { files?: { path: string; kind: string; origin?: string }[] }[] = [];
      rt.events.on((e) => {
        if (e.type === 'file.card') cards.push(e as never);
      });
      const s = rt.createSession();
      await s.send('draw it').done;
      // the second request carries the tool's image after the tool message (OpenAI-compatible)
      const msgs = gw.requests[1]!.body.messages as { role: string; content: unknown; tool_call_id?: string }[];
      const tool = msgs.findIndex((m) => m.role === 'tool');
      expect(String(msgs[tool]!.content)).toMatch(/图片：.+\.png/);
      expect(JSON.stringify(msgs[tool + 1])).toMatch(/"role":"user".*data:image\/png;base64,/);
      // one card, for the kept copy in the conversation's media folder
      expect(cards).toHaveLength(1);
      const path = cards[0]!.files![0]!.path;
      expect(cards[0]!.files![0]).toMatchObject({ kind: 'other', origin: 'produced' });
      expect(path.startsWith(rt.mediaDir(s.id))).toBe(true);
      // the results message keeps the image block (history, a later request)
      const results = s.messages().find((m) => m.meta?.fileCardLists)!;
      expect(results.content.map((b) => b.type)).toEqual(['tool_result', 'image']);
      await rt.deleteSession(s.id);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(rt.mediaDir(s.id)) ? readdirSync(rt.mediaDir(s.id)) : []).toEqual([]);
    } finally {
      await rt.close();
    }
  });
});

describe('images after tool results, Anthropic format', () => {
  it('the tool_result comes first in the user turn, the image after it', () => {
    const path = keepMedia(dir, 'image', PNG_1X1, 'image/png')!.image!.path;
    const out = toAnthropicMessages(
      [
        { id: 'a', sessionId: 's', role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'pic__make', input: {} }], createdAt: '2026-11-11T00:00:00Z' },
        {
          id: 'r',
          sessionId: 's',
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'p1', content: '图片：x.png' },
            { type: 'image', path, mediaType: 'image/png', width: 1, height: 1, bytes: 70 },
          ],
          createdAt: '2026-11-11T00:00:01Z',
        },
      ] as never,
      'anthropic',
    );
    const user = out.at(-1) as { role: string; content: { type: string }[] };
    expect(user.role).toBe('user');
    expect(user.content.map((b) => b.type)).toEqual(['tool_result', 'image']);
  });
});
