// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PlanStep } from '@spica/protocol';
import { PlanStrip } from './PlanStrip';

afterEach(cleanup);

const steps: PlanStep[] = [
  { step: '读评审记录', status: 'completed' },
  { step: '起草评审纪要', status: 'in_progress' },
  { step: '整理成邮件草稿', status: 'pending' },
];

describe('PlanStrip', () => {
  it('one line: which step of how many, and the step being worked on; opens to all of them', () => {
    const { container } = render(<PlanStrip steps={steps} running={false} />);
    expect(container.querySelector('.plan-line')?.textContent).toBe('2 / 3起草评审纪要');
    expect(container.querySelector('.plan-steps')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect([...container.querySelectorAll('.plan-step-text')].map((n) => n.textContent)).toEqual(['读评审记录', '起草评审纪要', '整理成邮件草稿']);
  });

  it('all done: 已完成', () => {
    const { container } = render(<PlanStrip steps={steps.map((s) => ({ ...s, status: 'completed' }))} running={false} />);
    expect(container.querySelector('.plan-line')?.textContent).toBe('3 / 3已完成');
  });

  it('opened, it closes to its line when a question comes (oneLine), and stays open across updates', () => {
    const { container, rerender } = render(<PlanStrip steps={steps} running />);
    fireEvent.click(screen.getByRole('button'));
    rerender(<PlanStrip steps={steps.map((s, i) => (i === 1 ? { ...s, status: 'completed' } : s))} running />);
    expect(container.querySelector('.plan-steps')).not.toBeNull();
    rerender(<PlanStrip steps={steps} running oneLine />);
    expect(container.querySelector('.plan-steps')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.plan-steps')).not.toBeNull();
  });
});
