// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

describe('ModelPicker: the headings 已启用 and 未启用', () => {
  const picker = (catalog: { id: string; contextWindow: number }[], selected: { id: string; contextWindow: number; contextFrom: 'catalog' }[]) =>
    render(<ModelPicker catalog={catalog} fetched={null} selected={selected} matchedNames={{}} onToggle={vi.fn()} onWindow={vi.fn()} onAdd={vi.fn()} fetching={false} fetchError={null} />);

  it('a heading only over models: none in use, no 已启用; none left, no 未启用', () => {
    picker([{ id: 'a', contextWindow: 1000 }], []);
    expect(screen.queryByText('已启用')).toBeNull();
    expect(screen.getByText('未启用')).toBeTruthy();
    cleanup();
    picker([{ id: 'a', contextWindow: 1000 }], [{ id: 'a', contextWindow: 1000, contextFrom: 'catalog' }]);
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.queryByText('未启用')).toBeNull();
  });

  it('no models at all: no headings, only 手动输入模型', () => {
    picker([], []);
    expect(screen.queryByText('已启用')).toBeNull();
    expect(screen.queryByText('未启用')).toBeNull();
    expect(screen.getByRole('button', { name: '手动输入模型' })).toBeTruthy();
  });
});
