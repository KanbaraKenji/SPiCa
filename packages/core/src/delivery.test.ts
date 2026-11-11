// The hand-over rule in the system prompt: how to name paths, show images,
// cite pages, offer next steps and wrap up. Sent to every conversation that
// talks to the user, with the real working folder in its examples.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveryRule } from './session.ts';
import type { FakeGateway, ReceivedRequest } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

const system = (r: ReceivedRequest | undefined): string => {
  const first = (r?.body.messages as { role: string; content: unknown }[] | undefined)?.[0];
  return first?.role === 'system' ? String(first.content) : '';
};

describe('the hand-over rule', () => {
  it('uses the working folder in its examples and ends folders with a separator', () => {
    const win = deliveryRule({ cwd: 'D:\\工作\\报价', suggest: true, platform: 'win32' });
    expect(win).toContain('`D:\\工作\\报价\\`');
    expect(win).toContain('`D:\\工作\\报价\\summary.xlsx`');
    expect(win).toContain('![what it shows](<D:\\工作\\报价\\chart 1.png>)');
    // web images: https only, and only when the image is wanted (each one is fetched from its site)
    expect(win).toContain('by its https address, but only when the user wants to see it or the image is the result itself');
    expect(win).toContain('http addresses and network-share paths do not display');
    expect(win).not.toContain('not web images');
    expect(win).toContain('suggest_actions');
    const mac = deliveryRule({ cwd: '/Users/me/work/', suggest: false, platform: 'darwin' });
    expect(mac).toContain('`/Users/me/work/summary.xlsx`');
    expect(mac).not.toContain('suggest_actions'); // only when the conversation has the tool
  });

  it('goes to the user conversations and sub-agents, not to mail sorting', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    gw.onRequest(() => ({ text: 'ok' }));
    const chat = rt.createSession({ cwd: dir });
    await chat.send('hi').done;
    expect(system(gw.requests.at(-1))).toContain('Handing over results');
    expect(system(gw.requests.at(-1))).toContain(dir);
    const child = rt.createSession({ parentId: chat.id });
    await child.send('task').done;
    expect(system(gw.requests.at(-1))).toContain('Handing over results');
    const mail = rt.createSession({ templateId: 'mail-triage' });
    await mail.send('sort these').done;
    expect(system(gw.requests.at(-1))).not.toContain('Handing over results');
    // counted under the rules in the context ring
    const rules = chat.contextBreakdown().parts.find((p) => p.key === 'system')?.children?.find((c) => c.key === 'system.rules');
    expect(rules?.tokens ?? 0).toBeGreaterThan(0);
    await rt.close();
  });
});
