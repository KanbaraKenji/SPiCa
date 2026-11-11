// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusSlot } from './StatusMark';

afterEach(cleanup);

describe('a sidebar row’s status place', () => {
  it('stopped is the error’s red dot, not an icon; the hover still says 已停止', () => {
    render(<StatusSlot slot={{ kind: 'stopped', text: '已停止' }} />);
    const mark = screen.getByRole('img', { name: '已停止' });
    expect(mark.getAttribute('title')).toBe('已停止');
    expect(mark.className).toBe('status-slot is-stopped');
    expect(mark.querySelector('.slot-dot')).toBeTruthy();
    expect(mark.querySelector('svg')).toBeNull();
    // Its colour is the error's: see main/renderer-styles.test.ts.
  });

  it('running and queued keep their icons', () => {
    render(<StatusSlot slot={{ kind: 'running', text: '思考中' }} />);
    expect(screen.getByRole('img', { name: '思考中' }).querySelector('.slot-dot')).toBeNull();
  });
});
