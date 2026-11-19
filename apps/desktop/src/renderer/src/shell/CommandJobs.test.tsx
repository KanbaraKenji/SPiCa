// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CommandJob, SessionInfo } from '@spica/protocol';
import { DetailPanel } from './DetailPanel';
import { jobsInOrder, runningJobs } from './CommandJobs';
import type { Transcript } from '../store/transcript';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const at = '2026-11-13T10:00:00.000Z';
const session = { id: 's', title: '演示', role: 'top', status: 'idle', parentId: null, parentChain: [], cwd: 'D:\\工作', costUsd: 0, createdAt: at, updatedAt: at } as unknown as SessionInfo;
const props = { globalCostUsd: 0, onOpenFile: vi.fn(), onOpenSession: vi.fn(), session, parent: undefined };

const job = (id: string, over: Partial<CommandJob>): CommandJob => ({ id, sessionId: 's', callId: `c-${id}`, command: 'npm run dev', cwd: 'D:\\工作', startedAt: at, outputPath: `D:\\x\\${id}.log`, ...over });

const withJobs = (...jobs: CommandJob[]): Transcript => ({ items: [], jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) }) as unknown as Transcript;

const rows = () => [...document.querySelectorAll('.detail-job')] as HTMLElement[];

describe('详情 › 后台命令', () => {
  it('no background command: no section', () => {
    render(<DetailPanel {...props} transcript={withJobs()} />);
    expect(screen.queryByText('后台命令')).toBeNull();
  });

  it('running ones first with their time ticking and 停止; ended ones after, newest first, with how they ended', () => {
    vi.useFakeTimers({ now: Date.parse(at) + 125_000 });
    const onStopJob = vi.fn();
    render(
      <DetailPanel
        {...props}
        onStopJob={onStopJob}
        transcript={withJobs(
          job('cmd3', { command: 'node build.js', startedAt: '2026-11-13T09:00:00.000Z', endedAt: '2026-11-13T09:00:07.000Z', end: 'exited', exitCode: 0 }),
          job('cmd1', { description: '启动预览服务' }),
          job('cmd4', { command: 'python serve.py', startedAt: '2026-11-13T09:10:00.000Z', endedAt: '2026-11-13T09:14:05.000Z', end: 'user' }),
          job('cmd2', { command: 'npx vitest --watch', startedAt: '2026-11-13T10:01:00.000Z' }),
          job('cmd5', { command: 'node crash.js', startedAt: '2026-11-13T08:00:00.000Z', endedAt: '2026-11-13T08:00:01.000Z', end: 'app_crashed' }),
        )}
      />,
    );
    expect(document.querySelector('.detail-section h3')?.textContent).toBeTruthy();
    const title = [...document.querySelectorAll('.detail-title')].find((h) => h.textContent?.startsWith('后台命令'));
    expect(title?.textContent).toBe('后台命令5');
    expect(rows().map((r) => r.querySelector('.detail-item-main')?.textContent)).toEqual(['启动预览服务 npm run dev', 'npx vitest --watch', 'python serve.py', 'node build.js', 'node crash.js']);
    expect(rows().map((r) => r.querySelector('.detail-item-meta')?.textContent)).toEqual(['2m 5s', '1m 5s', '已停止 · 4m 5s', '7s', '已中断']);
    act(() => void vi.advanceTimersByTime(2000));
    expect(rows()[0]!.querySelector('.detail-item-meta')?.textContent).toBe('2m 7s');
    // 停止 only on the running ones, an icon button with its words in the hover
    const stops = screen.getAllByRole('button', { name: /^停止 / });
    expect(stops).toHaveLength(2);
    expect(stops[0]!.getAttribute('title')).toBe('停止');
    expect(stops[0]!.className).toContain('icon-btn');
    fireEvent.click(stops[1]!);
    expect(onStopJob).toHaveBeenCalledWith('cmd2');
    expect(rows()[0]!.getAttribute('title')).toBe('npm run dev');
  });

  it('order and count helpers', () => {
    const jobs = { a: job('a', { end: 'agent', endedAt: at }), b: job('b', {}) };
    expect(jobsInOrder(jobs).map((j) => j.id)).toEqual(['b', 'a']);
    expect(runningJobs(jobs)).toBe(1);
    expect(runningJobs(undefined)).toBe(0);
  });
});
