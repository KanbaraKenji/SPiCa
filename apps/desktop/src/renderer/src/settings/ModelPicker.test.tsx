// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelPicker } from './ModelPicker';

afterEach(cleanup);

describe('ModelPicker: 支持图片', () => {
  it('an eye after the catalog models that take pictures, in use and not; none on text-only or unknown ones', () => {
    render(
      <ModelPicker
        catalog={[
          { id: 'qwen-vl-max', contextWindow: 131072, vision: true },
          { id: 'deepseek-flash', contextWindow: 131072, vision: false },
          { id: 'qwen-omni', contextWindow: 65536, vision: true },
          { id: 'mystery', contextWindow: 32768 },
        ]}
        fetched={null}
        selected={[
          { id: 'qwen-vl-max', contextWindow: 131072, contextFrom: 'catalog' },
          { id: 'deepseek-flash', contextWindow: 131072, contextFrom: 'catalog' },
        ]}
        matchedNames={{}}
        onToggle={vi.fn()}
        onWindow={vi.fn()}
        onAdd={vi.fn()}
        fetching={false}
        fetchError={null}
      />,
    );
    const rowOf = (id: string) => screen.getByText(id).closest('.model-row, .model-pill') as HTMLElement;
    // 已启用
    expect(rowOf('qwen-vl-max').querySelector('.image-mark')?.getAttribute('title')).toBe('支持图片');
    expect(rowOf('deepseek-flash').querySelector('.image-mark')).toBeNull();
    // 未启用
    expect(rowOf('qwen-omni').querySelector('.image-mark')).not.toBeNull();
    expect(rowOf('mystery').querySelector('.image-mark')).toBeNull();
  });
});

describe('ModelPicker: 花费上限 on each model in use', () => {
  const picker = (selected: Parameters<typeof ModelPicker>[0]['selected'], onRunLimit = vi.fn()) =>
    render(
      <ModelPicker
        catalog={[{ id: 'deepseek-flash', contextWindow: 131072 }]}
        fetched={null}
        selected={selected}
        matchedNames={{}}
        onToggle={vi.fn()}
        onWindow={vi.fn()}
        onRunLimit={onRunLimit}
        onAdd={vi.fn()}
        fetching={false}
        fetchError={null}
      />,
    );

  it('none: 「花费不限」; set: 「花费上限 US$2」; a click edits it, an amount to the cent, empty is none, anything else is NaN (saving says why)', () => {
    const onRunLimit = vi.fn();
    picker([{ id: 'deepseek-flash', contextWindow: 131072, contextFrom: 'catalog' }], onRunLimit);
    fireEvent.click(screen.getByRole('button', { name: 'deepseek-flash 花费上限' }));
    const box = screen.getByRole('textbox', { name: 'deepseek-flash 花费上限（美元）' }) as HTMLInputElement;
    expect(box.placeholder).toBe('不限');
    fireEvent.change(box, { target: { value: '2.005' } });
    expect(onRunLimit).toHaveBeenLastCalledWith('deepseek-flash', 2.01);
    fireEvent.change(box, { target: { value: '' } });
    expect(onRunLimit).toHaveBeenLastCalledWith('deepseek-flash', undefined);
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(onRunLimit.mock.lastCall?.[1]).toBeNaN();
    cleanup();
    picker([{ id: 'deepseek-flash', contextWindow: 131072, contextFrom: 'catalog', runLimitUsd: 2 }]);
    expect(screen.getByRole('button', { name: 'deepseek-flash 花费上限' }).textContent).toBe('花费上限 US$2');
    cleanup();
    picker([{ id: 'deepseek-flash', contextWindow: 131072, contextFrom: 'catalog' }]);
    expect(screen.getByRole('button', { name: 'deepseek-flash 花费上限' }).textContent).toBe('花费不限');
  });

  it('not an amount: the box stays open and is marked', () => {
    picker([{ id: 'deepseek-flash', contextWindow: 131072, contextFrom: 'catalog', runLimitUsd: Number.NaN }]);
    const box = screen.getByRole('textbox', { name: 'deepseek-flash 花费上限（美元）' });
    expect(box.className).toContain('is-invalid');
  });
});
