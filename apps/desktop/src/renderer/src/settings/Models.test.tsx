// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Models, type ProvidersApi } from './Models';
import type { ProviderList } from '../../../shared/bridge';
import type { ProviderDraft, ProviderView } from '../../../shared/providers';

afterEach(cleanup);

function fakeApi(initial: ProviderView[] = []) {
  let items = initial;
  const list = (): ProviderList => ({ items, problems: {} });
  const api: ProvidersApi = {
    list: vi.fn(async () => list()),
    save: vi.fn(async (d: ProviderDraft) => {
      const { secret, ...fields } = d;
      const id = d.id ?? `p-${items.length + 1}`;
      const view: ProviderView = { ...fields, id, hasSecret: Boolean(secret) || Boolean(items.find((i) => i.id === id)?.hasSecret), isDefault: items.length === 0 };
      items = d.id ? items.map((i) => (i.id === id ? view : i)) : [...items, view];
      return list();
    }),
    remove: vi.fn(async (id: string) => {
      items = items.filter((i) => i.id !== id);
      return list();
    }),
    setDefault: vi.fn(async (id: string) => {
      items = items.map((i) => ({ ...i, isDefault: i.id === id }));
      return list();
    }),
    test: vi.fn(async () => ({ ok: true, message: '连得上，模型「m」可以用。' })),
  };
  return api;
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Models', () => {
  it('points out missing fields before testing or saving', async () => {
    const api = fakeApi();
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(screen.getByText('起个名字，方便在列表里认出来')).toBeTruthy();
    expect(screen.getByText('填接口地址')).toBeTruthy();
    expect(api.test).not.toHaveBeenCalled();
  });

  it('shows the WSO2 fields only for WSO2', async () => {
    render(<Models api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'WSO2 网关' }));
    expect(screen.getByLabelText('取 token 地址')).toBeTruthy();
    expect(screen.getByLabelText('Client Secret')).toBeTruthy();
  });

  it('tests, saves, and then keeps the key hidden', async () => {
    const api = fakeApi();
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    type('名称', '公司网关');
    type('接口地址', 'https://api.example.com/v1');
    type('API Key', 'sk-1');
    type('模型', 'm');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('连得上，模型「m」可以用。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(screen.getByRole('button', { name: /公司网关/ })).toBeTruthy();
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('API Key') as HTMLInputElement).placeholder).toBe('已保存；不改就留空');
  });

  it('deletes only after confirming', async () => {
    const api = fakeApi([
      { id: 'p-1', kind: 'openai', name: '旧网关', baseUrl: 'https://a/v1', model: 'm', strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, hasSecret: true, isDefault: true },
    ]);
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧网关/ }));
    fireEvent.click(screen.getByRole('button', { name: /删除/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('删除模型「旧网关」？');
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('p-1'));
  });
});
