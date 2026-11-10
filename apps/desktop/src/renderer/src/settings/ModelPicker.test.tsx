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
