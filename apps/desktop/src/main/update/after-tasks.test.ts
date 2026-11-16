import { describe, expect, it, vi } from 'vitest';
import { afterTasks } from './after-tasks';
import type { UpdateState } from '../../shared/updates';

const ready: UpdateState = { status: 'ready', current: '0.1.0', available: '0.1.1', source: 'D:/更新', sourceFromDeploy: true, portable: false };

function setup(running: boolean) {
  const state = { running };
  const install = vi.fn(() => true);
  const changed = vi.fn();
  const a = afterTasks({ busy: () => state.running, install, changed });
  return { a, state, install, changed };
}

describe('任务结束后更新', () => {
  it('nothing running: installs at once', () => {
    const { a, install } = setup(false);
    a.request();
    expect(install).toHaveBeenCalledTimes(1);
    expect(a.view(ready).afterTasks).toBeUndefined();
  });

  it('running: waits and says so; installs when the last one finishes, not before', () => {
    const { a, state, install, changed } = setup(true);
    a.request();
    expect(install).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(a.view(ready)).toMatchObject({ afterTasks: true });
    // another status event while still running
    a.seen();
    expect(install).not.toHaveBeenCalled();
    state.running = false;
    a.seen();
    expect(install).toHaveBeenCalledTimes(1);
    expect(a.view(ready).afterTasks).toBeUndefined();
    // once only
    a.seen();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('only a downloaded version is said to wait', () => {
    const { a } = setup(true);
    a.request();
    expect(a.view({ ...ready, status: 'latest' }).afterTasks).toBeUndefined();
  });

  it('nothing left to install when the tasks end: the window hears the state again', () => {
    const { a, state, install, changed } = setup(true);
    install.mockReturnValue(false);
    a.request();
    state.running = false;
    a.seen();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
