// 操作电脑 in the main process, put together for main/index.ts: the driver (the real one only where driverKind
// says so; the made-up desktop otherwise), the agent (agent.ts) with the settings as its store, the bar, the host
// methods the core's computer_* tools call, and letting go of the computer when the run that held it ends.
import { join } from 'node:path';
import { app, nativeImage, screen } from 'electron';
import type { SettingsStore } from '../settings-store';
import { ComputerAgent } from './agent';
import { ComputerBar, type BarLook } from './bar';
import { driverKind, type Driver } from './driver';
import { FakeDriver } from './fake-driver';

/** Statuses of a conversation that is still running (main/tray.ts RUNNING): the computer stays held. */
const RUNNING = new Set(['queued', 'thinking', 'tool', 'awaiting_confirm', 'awaiting_answer']);

/** What the made-up desktop has open (test windows, the demo backend). */
const FAKE_OPEN = ['C:\\Windows\\System32\\notepad.exe', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];

export interface ComputerSetup {
  /** Host methods for the core ('computer.*'). */
  hostMethods: Record<string, (sessionId: string, args: Record<string, unknown>) => Promise<unknown>>;
  /** Every event of the core: a run that ended lets go of the computer. */
  seen(e: { type: string; sessionId?: string; status?: string }): void;
  /** A conversation was deleted. */
  forget(sessionId: string): void;
  /** The bar's page as it is now ('' when there is none). */
  barHtml(): Promise<string>;
}

export function setupComputer(opts: { settings: SettingsStore; hidden: boolean; look: () => Omit<BarLook, 'mark'>; abort: (sessionId: string) => void }): ComputerSetup {
  const kind = driverKind(process.env, { packaged: app.isPackaged, platform: process.platform });
  let agent: Promise<ComputerAgent> | undefined;
  const mark = (() => {
    const img = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'branding', 'png', 'spica-icon-32.png'));
    return img.isEmpty() ? '' : img.toDataURL();
  })();
  const bar = new ComputerBar({
    hidden: opts.hidden,
    look: () => ({ ...opts.look(), mark }),
    onStop: () => void agent?.then((a) => a.stop()),
    // top centre of the main screen's work area
    place: (width) => {
      const wa = screen.getPrimaryDisplay().workArea;
      return { x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y + 8 };
    },
  });
  const get = (): Promise<ComputerAgent> =>
    (agent ??= (async () => {
      const driver: Driver = kind === 'real' ? await (await import('./driver-win32')).Win32Driver.create() : new FakeDriver({ open: FAKE_OPEN });
      return new ComputerAgent({
        driver,
        store: {
          always: () => opts.settings.get().computerUse.always,
          addAlways: (apps) => {
            const c = opts.settings.get().computerUse;
            opts.settings.update({ computerUse: { ...c, always: [...c.always, ...apps] } });
          },
          denied: () => opts.settings.get().computerUse.denied,
        },
        onState: (s) => bar.update(s),
        onStop: (id) => opts.abort(id),
      });
    })());
  const method =
    (name: 'prepare' | 'grant' | 'listApps' | 'screenshot' | 'zoom' | 'click' | 'drag' | 'scroll' | 'type' | 'key' | 'open') =>
    async (sessionId: string, args: Record<string, unknown>) => {
      if (!opts.settings.get().computerUse.enabled) throw new Error('operating the computer is switched off in the settings');
      const a = await get();
      return (a[name] as (s: string, x: Record<string, unknown>) => unknown).call(a, sessionId, args ?? {});
    };
  return {
    hostMethods: {
      'computer.prepare': method('prepare'),
      'computer.grant': method('grant'),
      'computer.listApps': method('listApps'),
      'computer.screenshot': method('screenshot'),
      'computer.zoom': method('zoom'),
      'computer.click': method('click'),
      'computer.drag': method('drag'),
      'computer.scroll': method('scroll'),
      'computer.type': method('type'),
      'computer.key': method('key'),
      'computer.open': method('open'),
    },
    seen(e) {
      if (e.type !== 'status' || !e.sessionId || (e.status && RUNNING.has(e.status))) return;
      const id = e.sessionId;
      void agent?.then((a) => {
        if (a.state()?.sessionId === id) a.release(id);
      });
    },
    forget(sessionId) {
      void agent?.then((a) => a.forgetSession(sessionId));
    },
    barHtml: () => bar.html(),
  };
}
