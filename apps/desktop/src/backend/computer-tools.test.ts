// The computer_* tools in a real core conversation (the fake model gateway), asking the main process's agent on the
// made-up desktop: nothing here touches the real screen, mouse or keyboard.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentApi } from '@spica/core';
import type { FakeGateway } from '../../../../packages/core/src/testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir, until } from '../../../../packages/core/src/testing/helpers.ts';
import { ComputerAgent, type AlwaysApp } from '../main/computer/agent';
import { FakeDriver } from '../main/computer/fake-driver';
import { accessText, computerHook, computerTools, KEEP_SCREENSHOTS, type HostCall } from './computer-tools';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const EXCEL = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

function setup(opts: { enabled?: boolean; images?: boolean } = {}) {
  const driver = new FakeDriver({ open: [EXCEL, NOTEPAD] });
  let always: AlwaysApp[] = [];
  const agent = new ComputerAgent({ driver, store: { always: () => always, addAlways: (a) => (always = [...always, ...a]), denied: () => [] } });
  const host: HostCall = async (method, params) => {
    const [sessionId, args] = params as [string, Record<string, unknown>];
    const name = method.replace(/^computer\./, '') as 'prepare';
    return (agent[name] as (s: string, a: Record<string, unknown>) => unknown).call(agent, sessionId, args);
  };
  const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media') });
  for (const t of computerTools(host, { enabled: () => opts.enabled ?? true, takesImages: () => opts.images ?? true })) rt.tools.register(t, 'desktop');
  rt.hooks.register('desktop-computer', computerHook(host));
  return { rt, api: createAgentApi(rt), driver, agent, always: () => always };
}

describe('computer tools', () => {
  it('offered only when switched on, to the top-level conversation, with a model that takes images, not for mail sorting', () => {
    const tools = computerTools(async () => ({}), { enabled: () => true, takesImages: (_p, m) => m !== 'text-only' });
    const t = tools.find((x) => x.spec.name === 'computer_screenshot')!;
    expect(t.available?.({ providerId: 'p', model: 'm', role: 'top', serverWebSearch: false })).toBe(true);
    expect(t.available?.({ providerId: 'p', model: 'm', role: 'worker', serverWebSearch: false })).toBe(false);
    expect(t.available?.({ providerId: 'p', model: 'text-only', role: 'top', serverWebSearch: false })).toBe(false);
    expect(t.available?.({ providerId: 'p', model: 'm', role: 'top', templateId: 'mail-triage', serverWebSearch: false })).toBe(false);
    const off = computerTools(async () => ({}), { enabled: () => false, takesImages: () => true });
    expect(off.every((x) => !x.available?.({ providerId: 'p', model: 'm', role: 'top', serverWebSearch: false }))).toBe(true);
    expect(tools.map((x) => x.spec.name)).toEqual([
      'computer_request_access',
      'computer_list_apps',
      'computer_open_application',
      'computer_screenshot',
      'computer_zoom',
      'computer_left_click',
      'computer_right_click',
      'computer_middle_click',
      'computer_double_click',
      'computer_triple_click',
      'computer_mouse_move',
      'computer_left_click_drag',
      'computer_scroll',
      'computer_type',
      'computer_key',
      'computer_wait',
      'computer_batch',
    ]);
    // screenshots are outside content; only the newest few go again
    expect(t.untrusted).toBe('file');
    expect(t.keepImages).toEqual({ group: 'computer-screen', newest: KEEP_SCREENSHOTS });
  });

  it('one card for the programs; 始终允许 keeps them for every conversation; then it sees and clicks', async () => {
    const { rt, api, driver, always } = setup();
    const s = rt.createSession();
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'computer_request_access', args: { apps: ['notepad', 'Microsoft Excel'], reason: '整理清单' } }] }, { text: 'ok' });
    await api.send(s.id, '把清单整理到记事本');
    await until(() => s.pending().length > 0);
    const card = s.pending()[0]!;
    expect(card).toMatchObject({ kind: 'confirm', toolName: 'computer_request_access', reason: 'computer_request_access' });
    const prepared = (card as { input: { prepared: { apps: { name: string; state: string }[] } } }).input.prepared;
    expect(prepared.apps.map((a) => [a.name, a.state])).toEqual([
      ['记事本', 'ask'],
      ['Microsoft Excel', 'ask'],
    ]);
    // a reply in the chat is not an approval: the card is still waiting
    expect(driver.sent).toEqual([]);
    await api.confirm(s.id, 'r1', true, { always: true });
    await until(() => s.pending().length === 0 && gw.requests.length === 2);
    expect(always().map((a) => a.name)).toEqual(['记事本', 'Microsoft Excel']);
    expect(JSON.stringify(gw.requests[1]!.body)).toContain('approved for every conversation');

    // a later request for the same programs: no card
    gw.enqueue(
      { toolCalls: [{ id: 'r2', name: 'computer_request_access', args: { apps: ['notepad'] } }] },
      { toolCalls: [{ id: 'k1', name: 'computer_screenshot', args: {} }] },
      { toolCalls: [{ id: 'k2', name: 'computer_left_click', args: { coordinate: [400, 400] } }] },
      { text: 'done' },
    );
    await api.send(s.id, '继续');
    await until(() => gw.requests.length === 6);
    expect(s.pending()).toEqual([]);
    const sent = JSON.stringify(gw.requests[4]!.body);
    expect(sent).toContain('Screenshot of the screen');
    expect(sent).toContain('"type":"image_url"');
    expect(driver.sent.map((x) => x.kind)).toEqual(['move', 'button', 'button']);
    await rt.close();
  });

  it('declined: nothing allowed, nothing sent', async () => {
    const { rt, api, driver, agent } = setup();
    const s = rt.createSession();
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'computer_request_access', args: { apps: ['notepad'] } }] }, { toolCalls: [{ id: 'k1', name: 'computer_type', args: { text: 'x' } }] }, { text: 'ok' });
    await api.send(s.id, 'go');
    await until(() => s.pending().length > 0);
    await api.confirm(s.id, 'r1', false);
    await until(() => gw.requests.length === 3);
    expect(JSON.stringify(gw.requests[2]!.body)).toContain('not approved for this conversation');
    expect(driver.sent).toEqual([]);
    expect((await agent.prepare(s.id, { apps: ['notepad'], callId: 'x' })).ask).toBe(true);
    await rt.close();
  });

  it('what the model is told about each program', () => {
    expect(
      accessText(
        {
          apps: [
            { asked: 'a', exe: 'A.exe', name: 'A', tier: 'full', highRisk: true, state: 'ask' },
            { asked: 'p', exe: 'python.exe', name: 'Python', tier: 'full', shared: true, state: 'ask' },
            { asked: 'e', exe: 'msedge.exe', name: 'Edge', tier: 'view', state: 'allowed' },
            { asked: 't', exe: 'tws.exe', name: 'TWS', tier: 'blocked', state: 'blocked' },
          ],
          missing: ['nothing'],
          ask: true,
        },
        { always: true },
      ),
    ).toBe(
      [
        '- A (A.exe): approved for every conversation — full control, high risk',
        '- Python (python.exe): approved for this conversation — full control',
        '- Edge (msedge.exe): already approved — view only (screenshots; no clicks or typing)',
        '- TWS (tws.exe): restricted: it cannot be operated',
        '- "nothing": no such program found (computer_list_apps lists the programs with a window; a full path to its .exe works too)',
      ].join('\n'),
    );
  });
});
