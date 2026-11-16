// 任务结束后更新 (the busy dialog's main button): the downloaded version installs as soon as no conversation runs,
// whatever 自动更新 says (this time it was asked for), and until then the update state says it waits, so the side bar's
// card and 设置 › 关于 can say so. Forgotten when the app quits first (the card is back at the next start).
import type { UpdateState } from '../../shared/updates';

export interface AfterTasksDeps {
  /** A conversation is running (main/tray.ts runningTracker). */
  busy(): boolean;
  /** Installs the downloaded version (UpdateService.install); false when there is none. */
  install(): boolean;
  /** The state to show changed (sends it to the window). */
  changed(): void;
}

export interface AfterTasks {
  /** 任务结束后更新 pressed: installs now if nothing runs, else waits. */
  request(): void;
  /** After every status event: the last conversation finished while waiting, so it installs. */
  seen(): void;
  /** The update state as the window should see it (afterTasks while waiting for a downloaded version). */
  view(s: UpdateState): UpdateState;
}

export function afterTasks(deps: AfterTasksDeps): AfterTasks {
  let waiting = false;
  return {
    request() {
      if (!deps.busy()) {
        deps.install();
        return;
      }
      waiting = true;
      deps.changed();
    },
    seen() {
      if (!waiting || deps.busy()) return;
      waiting = false;
      // Nothing left to install (it went, or was never there): the card goes back to how it was.
      if (!deps.install()) deps.changed();
    },
    view: (s) => (waiting && s.status === 'ready' ? { ...s, afterTasks: true } : s),
  };
}
