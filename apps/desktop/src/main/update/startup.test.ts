import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../shared/updates';
import { STARTUP_WINDOW_MS, startupAction } from './startup';

const ready: UpdateState = { status: 'ready', current: '0.2.0', available: '0.2.1', source: 'x', sourceFromDeploy: true, portable: false };
const base = { update: ready, sinceStartMs: 15_000, busy: false, shown: true, done: false };

describe('startupAction', () => {
  it('an update downloaded soon after start is asked about once', () => {
    expect(startupAction(base)).toBe('ask');
    expect(startupAction({ ...base, done: true })).toBeNull();
    expect(startupAction({ ...base, sinceStartMs: STARTUP_WINDOW_MS + 1 })).toBeNull();
  });

  it('not while it downloads, nor with a conversation running, nor started into the tray, nor for a portable copy', () => {
    expect(startupAction({ ...base, update: { ...ready, status: 'downloading' } })).toBeNull();
    expect(startupAction({ ...base, busy: true })).toBeNull();
    expect(startupAction({ ...base, shown: false })).toBeNull();
    expect(startupAction({ ...base, update: { ...ready, status: 'manual', portable: true } })).toBeNull();
  });

  it('a version that must update: installed at once, from the moment it is found (its download shows), not asked', () => {
    expect(startupAction({ ...base, update: { ...ready, required: true } })).toBe('force');
    expect(startupAction({ ...base, update: { ...ready, status: 'downloading', required: true } })).toBe('force');
    expect(startupAction({ ...base, busy: true, shown: false, update: { ...ready, required: true } })).toBe('force');
    // found later while the app is in use: the card and 自动更新 (schedule.ts), not this
    expect(startupAction({ ...base, sinceStartMs: STARTUP_WINDOW_MS + 1, update: { ...ready, required: true } })).toBeNull();
    expect(startupAction({ ...base, update: { ...ready, status: 'manual', portable: true, required: true } })).toBeNull();
  });
});
