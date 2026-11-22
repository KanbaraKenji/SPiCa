// 操作电脑 on the made-up desktop: nothing here touches the real screen, mouse or keyboard.
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ComputerAgent, IDLE_MS, type AlwaysApp, type ComputerState } from './agent';
import { encodePng, fitForModel, maskScreen, MASK_GREY, resize, type Bitmap } from './bitmap';
import { computerMode } from './driver';
import { FAKE_SPICA_PID, FakeDriver } from './fake-driver';
import { clickSteps, keySteps } from './input';
import { allows, exeName, ruleFor } from '../../shared/computer-use';

const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const EXCEL = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function setup(open: string[] = [NOTEPAD, EXCEL], opts: { denied?: string[]; always?: AlwaysApp[] } = {}) {
  const driver = new FakeDriver({ open });
  let always: AlwaysApp[] = [...(opts.always ?? [])];
  const states: (ComputerState | null)[] = [];
  const stopped: string[] = [];
  let now = 0;
  const agent = new ComputerAgent({
    driver,
    store: { always: () => always, addAlways: (a) => (always = [...always, ...a]), denied: () => opts.denied ?? [] },
    onState: (s) => states.push(s),
    onStop: (id) => stopped.push(id),
    now: () => now,
  });
  return { driver, agent, states, stopped, always: () => always, tick: (ms: number) => (now += ms) };
}

async function allow(agent: ComputerAgent, sessionId: string, apps: string[], always = false) {
  const p = await agent.prepare(sessionId, { apps, callId: `c-${apps.join()}` });
  if (p.ask) agent.grant(sessionId, { callId: `c-${apps.join()}`, always });
  return p;
}

describe('whether it is there, on which driver', () => {
  const win = { platform: 'win32' };
  it('off unless SPICA_COMPUTER asks for it, installed copies too (until the real driver was checked on a real machine)', () => {
    expect(computerMode({}, { ...win, packaged: true })).toBe('off');
    expect(computerMode({}, { ...win, packaged: false })).toBe('off');
    expect(computerMode({ SPICA_COMPUTER: 'yes' }, { ...win, packaged: true })).toBe('off');
    expect(computerMode({ SPICA_COMPUTER: 'fake' }, { ...win, packaged: true })).toBe('off');
  });
  it('real only on Windows, never in a test window, with the demo backend or under the tests', () => {
    expect(computerMode({ SPICA_COMPUTER: 'real' }, { ...win, packaged: true })).toBe('real');
    expect(computerMode({ SPICA_COMPUTER: 'real' }, { ...win, packaged: false })).toBe('real');
    expect(computerMode({ SPICA_COMPUTER: 'real', SPICA_HIDDEN: '1' }, { ...win, packaged: false })).toBe('fake');
    expect(computerMode({ SPICA_COMPUTER: 'real', SPICA_BACKEND: 'fake' }, { ...win, packaged: false })).toBe('fake');
    expect(computerMode({ SPICA_COMPUTER: 'real', VITEST: 'true' }, { ...win, packaged: true })).toBe('fake');
    expect(computerMode({ SPICA_COMPUTER: 'real' }, { platform: 'darwin', packaged: true })).toBe('fake');
    expect(computerMode({ ...process.env, SPICA_COMPUTER: 'real' }, { ...win, packaged: true })).toBe('fake');
    expect(computerMode({ SPICA_COMPUTER: 'fake' }, { ...win, packaged: false })).toBe('fake');
  });
});

describe('restricted programs', () => {
  it('by the exe name, whatever the folder', () => {
    expect(exeName('C:\\Program Files\\X 1.2\\Tws.EXE')).toBe('tws.exe');
    expect(ruleFor('D:\\apps\\tws.exe').tier).toBe('blocked');
    expect(ruleFor(EDGE).tier).toBe('view');
    expect(ruleFor(PS).tier).toBe('click');
    expect(ruleFor('C:\\Windows\\explorer.exe')).toEqual({ tier: 'full', highRisk: true });
    expect(ruleFor('C:\\Python\\python.exe')).toEqual({ tier: 'full', shared: true });
    expect(ruleFor(NOTEPAD).tier).toBe('full');
    expect(ruleFor(NOTEPAD, { own: true }).tier).toBe('blocked');
    expect(ruleFor(NOTEPAD, { denied: ['Notepad.exe'] }).tier).toBe('blocked');
  });
  it('what each tier allows', () => {
    expect([allows('view', 'see'), allows('view', 'click'), allows('view', 'type')]).toEqual([true, false, false]);
    expect([allows('click', 'click'), allows('click', 'type')]).toEqual([true, false]);
    expect([allows('blocked', 'see'), allows('full', 'type')]).toEqual([false, true]);
  });
});

describe('keys and clicks', () => {
  it('combinations down in order, up the other way', () => {
    const r = keySteps('ctrl+s');
    expect('steps' in r && r.steps).toEqual([
      { kind: 'key', vk: 0x11, down: true },
      { kind: 'key', vk: 0x53, down: true },
      { kind: 'key', vk: 0x53, down: false },
      { kind: 'key', vk: 0x11, down: false },
    ]);
    expect('steps' in keySteps('Return', 3) && keySteps('Return', 3)).toMatchObject({ steps: { length: 6 } });
    expect(keySteps('ctrl+nosuchkey')).toEqual({ error: 'unknown key "nosuchkey"' });
    expect('steps' in keySteps('F5')).toBe(true);
  });
  it('a click holding a modifier', () => {
    const r = clickSteps(5, 6, 'left', 2, 'shift');
    expect('steps' in r && r.steps.map((s) => s.kind)).toEqual(['move', 'key', 'button', 'button', 'button', 'button', 'key']);
    expect(clickSteps(1, 1, 'left', 1, 'a')).toEqual({ error: '"a" is not a modifier key (shift, ctrl, alt, super)' });
  });
});

describe('pictures', () => {
  const solid = (w: number, h: number, v: number): Bitmap => ({ width: w, height: h, data: Buffer.alloc(w * h * 4, v) });
  it('greys what may not be seen, painting windows from the bottom up', () => {
    const src = solid(10, 10, 200);
    // top: a hidden window over the left half of an allowed full-screen one
    const out = maskScreen(src, [
      { rect: { x: 0, y: 0, width: 5, height: 10 }, visible: false },
      { rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true },
    ]);
    expect(out.data[0]).toBe(MASK_GREY);
    expect(out.data[(0 * 10 + 7) * 4]).toBe(200);
    // nothing covers it: grey
    expect(maskScreen(src, [])).toMatchObject({ data: Buffer.from(Array.from({ length: 400 }, (_, i) => (i % 4 === 3 ? 255 : MASK_GREY))) });
  });
  it('the model size follows Claude’s rule', () => {
    expect(fitForModel(1920, 1080)).toMatchObject({ width: 1430, height: 804 });
    expect(fitForModel(800, 600)).toMatchObject({ width: 800, height: 600, scale: 1 });
    expect(resize(solid(4, 4, 10), 2, 2).data.length).toBe(16);
  });
  it('a PNG that reads back', () => {
    const png = encodePng(solid(3, 2, 7));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const idat = png.indexOf('IDAT');
    const len = png.readUInt32BE(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + len)).length).toBe(2 * (3 * 3 + 1));
  });
});

describe('approval', () => {
  it('one card for every program not yet allowed; restricted ones are never on it', async () => {
    const { agent, driver } = setup([NOTEPAD, EXCEL, EDGE]);
    driver.open('D:\\Trader\\tws.exe');
    const p = await agent.prepare('s1', { apps: ['notepad', 'Microsoft Excel', 'msedge.exe', 'tws.exe', 'no such program'], callId: 'c1' });
    expect(p.ask).toBe(true);
    expect(p.missing).toEqual(['no such program']);
    expect(p.apps.map((a) => [a.name, a.tier, a.state])).toEqual([
      ['记事本', 'full', 'ask'],
      ['Microsoft Excel', 'full', 'ask'],
      ['Microsoft Edge', 'view', 'ask'],
      ['tws.exe', 'blocked', 'blocked'],
    ]);
  });
  it('允许一次 is this conversation only; a later card lists only the new ones', async () => {
    const { agent } = setup([NOTEPAD, EXCEL]);
    await agent.prepare('s1', { apps: ['notepad'], callId: 'c1' });
    expect(agent.grant('s1', { callId: 'c1', always: false }).granted.map((a) => a.name)).toEqual(['记事本']);
    const again = await agent.prepare('s1', { apps: ['notepad', 'excel'], callId: 'c2' });
    expect(again.apps.map((a) => a.state)).toEqual(['allowed', 'ask']);
    expect((await agent.prepare('s2', { apps: ['notepad'], callId: 'c3' })).ask).toBe(true);
  });
  it('始终允许 is kept in the settings for every conversation, except a shared exe', async () => {
    const { agent, driver, always } = setup([NOTEPAD]);
    driver.open('C:\\Python\\python.exe', { title: 'tool window' });
    const p = await agent.prepare('s1', { apps: ['notepad', 'python'], callId: 'c1' });
    expect(p.apps[1]).toMatchObject({ shared: true, title: 'tool window' });
    agent.grant('s1', { callId: 'c1', always: true });
    expect(always()).toEqual([{ exe: NOTEPAD, name: '记事本', icon: expect.stringMatching(/^data:image\/png;base64,/) }]);
    expect((await agent.prepare('s9', { apps: ['notepad'], callId: 'c2' })).ask).toBe(false);
    expect((await agent.prepare('s9', { apps: ['python'], callId: 'c3' })).ask).toBe(true);
  });
  it('始终允许 on a high-risk program counts for this conversation only: never kept, asked again in the next', async () => {
    const EXPLORER = 'C:\\Windows\\explorer.exe';
    const { agent, driver, always } = setup([NOTEPAD]);
    driver.open(EXPLORER);
    const p = await agent.prepare('s1', { apps: ['notepad', 'explorer'], callId: 'c1' });
    expect(p.apps[1]).toMatchObject({ exe: EXPLORER, highRisk: true, state: 'ask' });
    expect(agent.grant('s1', { callId: 'c1', always: true }).granted.map((a) => a.exe)).toEqual([NOTEPAD, EXPLORER]);
    expect(always().map((a) => a.exe)).toEqual([NOTEPAD]);
    expect((await agent.prepare('s1', { apps: ['explorer'], callId: 'c2' })).ask).toBe(false);
    expect((await agent.prepare('s9', { apps: ['notepad'], callId: 'c3' })).ask).toBe(false);
    expect((await agent.prepare('s9', { apps: ['explorer'], callId: 'c4' })).ask).toBe(true);
  });
  it('a high-risk program already in 始终允许的程序 is still asked for', async () => {
    const EXPLORER = 'C:\\Windows\\explorer.exe';
    const { agent, driver } = setup([], { always: [{ exe: EXPLORER, name: '文件资源管理器' }] });
    driver.open(EXPLORER);
    expect((await agent.prepare('s1', { apps: ['explorer'], callId: 'c1' })).ask).toBe(true);
  });
  it('what is granted comes from what was prepared for that call, never from the input', async () => {
    const { agent } = setup([NOTEPAD]);
    expect(() => agent.grant('s1', { callId: 'unknown', always: true, apps: ['notepad'] })).toThrow(/no longer known/);
    await agent.prepare('s1', { apps: ['notepad'], callId: 'c1' });
    expect(() => agent.grant('s2', { callId: 'c1' })).toThrow(/no longer known/);
  });
  it('Spica itself is never on a card', async () => {
    const { agent } = setup([]);
    const p = await agent.prepare('s1', { apps: ['Spica', 'Spica.exe'], callId: 'c1' });
    expect(p.ask).toBe(false);
    expect(p.apps).toEqual([]);
  });
  it('a program running as administrator is said so, not asked', async () => {
    const { agent, driver } = setup([]);
    driver.open(NOTEPAD, { elevated: true });
    expect((await agent.prepare('s1', { apps: ['notepad'], callId: 'c1' })).apps[0]?.state).toBe('elevated');
  });
});

describe('screenshots', () => {
  it('greys every program not allowed, the taskbar and Spica itself', async () => {
    const { agent, driver } = setup([NOTEPAD, EXCEL]);
    await allow(agent, 's1', ['notepad']);
    const shot = await agent.screenshot('s1');
    expect(shot).toMatchObject({ width: 1430, height: 804 });
    expect(shot.text).toContain('Visible: 记事本');
    const wins = await driver.windows();
    const excel = wins.find((w) => w.exe === EXCEL)!;
    const notepad = wins.find((w) => w.exe === NOTEPAD)!;
    // decode is not needed: the masked full-size picture is checked through the same steps the agent takes
    const raw = await driver.capture();
    const own = driver.ownPids();
    const masked = maskScreen(raw, wins.map((w) => ({ rect: w.rect, visible: !own.has(w.pid) && w.exe === NOTEPAD })));
    const at = (x: number, y: number) => masked.data[(y * raw.width + x) * 4];
    expect(at(excel.rect.x + excel.rect.width - 5, excel.rect.y + excel.rect.height - 5)).toBe(MASK_GREY);
    expect(at(notepad.rect.x + 10, notepad.rect.y + 10)).not.toBe(MASK_GREY);
    expect(at(5, 1075)).toBe(MASK_GREY);
  });
  it('the bar shows the screenshots and their tokens', async () => {
    const { agent, states } = setup([NOTEPAD]);
    await allow(agent, 's1', ['notepad']);
    await agent.screenshot('s1');
    await agent.screenshot('s1');
    expect(agent.state()).toMatchObject({ sessionId: 's1', shots: 2, tokens: 2 * Math.round((1430 * 804) / 750) });
    expect(states[0]).toMatchObject({ sessionId: 's1', shots: 0 });
  });
});

describe('acting', () => {
  async function ready(open = [NOTEPAD, EXCEL]) {
    const s = setup(open);
    await allow(s.agent, 's1', ['notepad']);
    await s.agent.screenshot('s1');
    const wins = await s.driver.windows();
    const scale = fitForModel(1920, 1080).scale;
    const inside = (exe: string) => {
      const w = wins.find((x) => x.exe === exe)!;
      return [Math.round((w.rect.x + w.rect.width - 40) * scale), Math.round((w.rect.y + w.rect.height - 40) * scale)];
    };
    return { ...s, inside };
  }
  it('clicks only where an approved program is on top', async () => {
    const { agent, driver, inside } = await ready();
    // Excel was opened last: it is on top of Notepad where they overlap; its own corner is not Notepad's
    await expect(agent.click('s1', { coordinate: inside(EXCEL) })).rejects.toThrow(/Microsoft Excel is not approved/);
    expect(driver.sent).toEqual([]);
    await driver.focus((await driver.windows()).find((w) => w.exe === NOTEPAD)!.id);
    const r = await agent.click('s1', { coordinate: inside(NOTEPAD) });
    expect(r.text).toMatch(/^Clicked at .* in 记事本\.$/);
    expect(driver.sent.map((s) => s.kind)).toEqual(['move', 'button', 'button']);
  });
  it('a view-only program takes no click, a click-only one no typing', async () => {
    const { agent, driver } = setup([EDGE, PS]);
    await allow(agent, 's1', ['msedge', 'powershell']);
    await agent.screenshot('s1');
    const wins = await driver.windows();
    const scale = fitForModel(1920, 1080).scale;
    const edge = wins.find((w) => w.exe === EDGE)!;
    await driver.focus(edge.id);
    await expect(agent.click('s1', { coordinate: [Math.round((edge.rect.x + 100) * scale), Math.round((edge.rect.y + 100) * scale)] })).rejects.toThrow(/view only/);
    await driver.focus(wins.find((w) => w.exe === PS)!.id);
    await expect(agent.type('s1', { text: 'dir' })).rejects.toThrow(/click only/);
    await expect(agent.key('s1', { text: 'Return' })).rejects.toThrow(/click only/);
    expect(driver.sent).toEqual([]);
  });
  it('typing goes to the program in front, as characters', async () => {
    const { agent, driver } = await ready([EXCEL, NOTEPAD]);
    expect((await agent.type('s1', { text: '你好' })).text).toBe('Typed 2 characters into 记事本.');
    expect(driver.sent).toEqual([{ kind: 'text', text: '你好' }]);
  });
  it('Spica’s bar on top of everything is not where typing goes: the program in front is', async () => {
    const { agent, driver } = await ready([EXCEL, NOTEPAD]);
    driver.openOnTop('C:\\Program Files\\Spica\\Spica.exe', FAKE_SPICA_PID, { x: 700, y: 8, width: 520, height: 44 });
    expect((await driver.windows())[0]?.pid).toBe(FAKE_SPICA_PID);
    expect((await agent.type('s1', { text: 'x' })).text).toBe('Typed 1 characters into 记事本.');
    // and the bar itself is never clicked
    const scale = fitForModel(1920, 1080).scale;
    await expect(agent.click('s1', { coordinate: [Math.round(800 * scale), Math.round(20 * scale)] })).rejects.toThrow(/Spica itself/);
  });

  it('nothing before a screenshot; coordinates outside it are refused', async () => {
    const { agent } = setup([NOTEPAD]);
    await allow(agent, 's1', ['notepad']);
    await expect(agent.click('s1', { coordinate: [1, 1] })).rejects.toThrow(/screenshot first/);
    await agent.screenshot('s1');
    await expect(agent.click('s1', { coordinate: [5000, 1] })).rejects.toThrow(/outside the screenshot/);
  });
  it('opens an approved program, starts one that is not running', async () => {
    const { agent, driver } = setup([]);
    await expect(agent.open('s1', { app: 'notepad' })).rejects.toThrow(/not approved/);
    await allow(agent, 's1', ['notepad']);
    expect((await agent.open('s1', { app: 'notepad' })).text).toMatch(/^Started 记事本/);
    expect(driver.launched).toEqual([NOTEPAD]);
    expect((await agent.open('s1', { app: 'notepad' })).text).toBe('记事本 is in front.');
  });
  it('a window the system keeps from the front is said so', async () => {
    const { agent, driver } = setup([NOTEPAD]);
    await allow(agent, 's1', ['notepad']);
    driver.refuseFocus.add((await driver.windows()).find((w) => w.exe === NOTEPAD)!.id);
    await expect(agent.open('s1', { app: 'notepad' })).rejects.toThrow(/did not let 记事本 come to the front/);
  });
});

describe('one conversation at a time; stopping', () => {
  it('another conversation is told, not queued; it may go on after the first lets go', async () => {
    const { agent } = setup([NOTEPAD]);
    await allow(agent, 's1', ['notepad']);
    await allow(agent, 's2', ['notepad']);
    await agent.screenshot('s1');
    await expect(agent.screenshot('s2')).rejects.toThrow(/another conversation/);
    agent.release('s1');
    await expect(agent.screenshot('s2')).resolves.toMatchObject({ width: 1430 });
  });
  it('an idle conversation lets go by itself', async () => {
    const { agent, tick } = setup([NOTEPAD]);
    await allow(agent, 's1', ['notepad']);
    await agent.screenshot('s1');
    tick(IDLE_MS + 1);
    expect(agent.state()).toBeNull();
  });
  it('the person’s Escape stops the run and lets go; the watch ends with it', async () => {
    const { agent, driver, stopped } = setup([NOTEPAD]);
    await allow(agent, 's1', ['notepad']);
    expect(driver.watchingEscape()).toBe(false);
    await agent.screenshot('s1');
    expect(driver.watchingEscape()).toBe(true);
    driver.pressEscape();
    expect(stopped).toEqual(['s1']);
    expect(agent.state()).toBeNull();
    expect(driver.watchingEscape()).toBe(false);
  });
  it('the person moving the mouse does not stop it (only 停止 and Escape do)', async () => {
    const { agent, stopped } = setup([NOTEPAD]);
    await allow(agent, 's1', ['notepad']);
    await agent.screenshot('s1');
    await agent.screenshot('s1');
    expect(stopped).toEqual([]);
    agent.stop();
    expect(stopped).toEqual(['s1']);
  });
});
