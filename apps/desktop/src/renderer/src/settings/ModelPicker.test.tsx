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
    const rowOf = (id: string) => screen.getByText(id).closest('.model-row') as HTMLElement;
    // 已启用
    expect(rowOf('qwen-vl-max').querySelector('.image-mark')?.getAttribute('title')).toBe('支持图片');
    expect(rowOf('deepseek-flash').querySelector('.image-mark')).toBeNull();
    // 未启用
    expect(rowOf('qwen-omni').querySelector('.image-mark')).not.toBeNull();
    expect(rowOf('mystery').querySelector('.image-mark')).toBeNull();
  });
});

describe('ModelPicker: one list, the tick says whether a model is in use', () => {
  const picker = (catalog: { id: string; contextWindow: number }[], selected: { id: string; contextWindow: number; contextFrom: 'catalog' }[], onToggle = vi.fn()) =>
    render(<ModelPicker catalog={catalog} fetched={null} selected={selected} matchedNames={{}} onToggle={onToggle} onWindow={vi.fn()} onAdd={vi.fn()} fetching={false} fetchError={null} />);

  it('no headings; every model a row with its box, the ticked ones first', () => {
    picker([{ id: 'a', contextWindow: 1000 }, { id: 'b', contextWindow: 2000 }, { id: 'c', contextWindow: 3000 }], [{ id: 'c', contextWindow: 3000, contextFrom: 'catalog' }]);
    expect(screen.queryByText('已启用')).toBeNull();
    expect(screen.queryByText('未启用')).toBeNull();
    expect(Array.from(document.querySelectorAll('.model-row-id')).map((x) => x.textContent)).toEqual(['c', 'a', 'b']);
    expect((screen.getByRole('checkbox', { name: 'c' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'a' }) as HTMLInputElement).checked).toBe(false);
    // only a ticked model has its 上下文上限
    expect(screen.getByRole('button', { name: 'c 上下文上限' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'a 上下文上限' })).toBeNull();
  });

  it('ticking a model does not move its row', () => {
    const onToggle = vi.fn();
    const catalog = [{ id: 'a', contextWindow: 1000 }, { id: 'b', contextWindow: 2000 }];
    const { rerender } = picker(catalog, [{ id: 'b', contextWindow: 2000, contextFrom: 'catalog' }], onToggle);
    fireEvent.click(screen.getByRole('checkbox', { name: 'a' }));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), true);
    rerender(<ModelPicker catalog={catalog} fetched={null} selected={[{ id: 'b', contextWindow: 2000, contextFrom: 'catalog' }, { id: 'a', contextWindow: 1000, contextFrom: 'catalog' }]} matchedNames={{}} onToggle={onToggle} onWindow={vi.fn()} onAdd={vi.fn()} fetching={false} fetchError={null} />);
    expect(Array.from(document.querySelectorAll('.model-row-id')).map((x) => x.textContent)).toEqual(['b', 'a']);
  });

  it('no models at all: no list, only 手动输入模型', () => {
    picker([], []);
    expect(document.querySelector('.model-picker-list')).toBeNull();
    expect(screen.getByRole('button', { name: '手动输入模型' })).toBeTruthy();
  });
});
