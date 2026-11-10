// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Models, type ProvidersApi } from './Models';
import type { ProviderList } from '../../../shared/bridge';
import type { ProviderDraft, ProviderView } from '../../../shared/providers';
import { dropAllDrafts } from './drafts';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

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
    knownWindow: vi.fn(async (_kind: string, model: string) => (model === 'claude-sonnet-5-5' ? 1_000_000 : null)),
  };
  return api;
}

// A label's text also holds the hint under the field, so match the start of it.
const byLabel = (label: string | RegExp) => screen.getByLabelText(typeof label === 'string' ? new RegExp(`^${label}`) : label);
const type = (label: string | RegExp, value: string) => fireEvent.change(byLabel(label), { target: { value } });

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
    expect(screen.queryByLabelText(/Consumer Key/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'WSO2 网关' }));
    expect(screen.getByLabelText(/^取 token 地址/)).toBeTruthy();
    expect(screen.getByLabelText(/^Consumer Secret/)).toBeTruthy();
  });

  it('WSO2: the names people are handed come first, each field says where it comes from', async () => {
    render(<Models api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'WSO2 网关' }));
    expect(screen.getByLabelText(/^Consumer Key/)).toBeTruthy();
    expect(screen.getByText('管理员给的模型接口地址，一般以 /v1 结尾，不带 /chat/completions')).toBeTruthy();
    expect(screen.getByText('一般以 /token 或 /oauth2/token 结尾')).toBeTruthy();
    expect(screen.getByText('也叫 Client ID。在 WSO2 开发者门户里，你的应用的 Production Keys 下面')).toBeTruthy();
    expect(screen.getByText('也叫 Client Secret。和 Consumer Key 在同一处（Production Keys）')).toBeTruthy();
    expect(screen.getByText('照管理员给的原样填，区分大小写，可以带斜杠')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(screen.getByText('填 Consumer Key')).toBeTruthy();
    expect(screen.getByText('填 Consumer Secret')).toBeTruthy();
    expect(screen.getByText('填网关地址')).toBeTruthy();
    // The error sits above the hint; the hint (where it comes from) stays.
    expect(screen.getByText('也叫 Client ID。在 WSO2 开发者门户里，你的应用的 Production Keys 下面')).toBeTruthy();
  });

  it('tests, saves, and then keeps the key hidden', async () => {
    const api = fakeApi();
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    type('名称', '公司网关');
    type('接口地址', 'https://api.example.com/v1');
    type('API Key', 'sk-1');
    type('模型', 'm');
    type(/^上下文上限/, '128000');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('连得上，模型「m」可以用。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(screen.getByRole('button', { name: /公司网关/ })).toBeTruthy();
    expect((byLabel('API Key') as HTMLInputElement).value).toBe('');
    expect((byLabel('API Key') as HTMLInputElement).placeholder).toBe('已保存；不改就留空');
  });

  it('keeps 强模型 and the limits under 更多选项, folded', async () => {
    render(<Models api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    expect(screen.queryByLabelText(/^强模型/)).toBeNull();
    expect(screen.queryByLabelText(/^同时请求/)).toBeNull();
    const more = screen.getByRole('button', { name: '更多选项' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByLabelText(/^强模型/)).toBeTruthy();
    expect(screen.getByLabelText(/^每分钟请求/)).toBeTruthy();
  });

  it('opens 更多选项 when something in it is wrong', async () => {
    render(<Models api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '更多选项' }));
    type(/^同时请求/, '-3');
    fireEvent.click(screen.getByRole('button', { name: '更多选项' }));
    expect(screen.queryByLabelText(/^同时请求/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('button', { name: '更多选项' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText(/^同时请求/)).toBeTruthy();
  });

  it('a half-filled form is still there after leaving the page', async () => {
    const api = fakeApi();
    const first = render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    type('名称', '公司网关');
    type('API Key', 'sk-1');
    first.unmount();

    render(<Models api={api} />);
    await screen.findByText('填了一半，还没保存');
    expect((byLabel('名称') as HTMLInputElement).value).toBe('公司网关');
    expect((byLabel('API Key') as HTMLInputElement).value).toBe('sk-1');
  });

  it('each model keeps its own unsaved edit; saving clears it', async () => {
    const api = fakeApi([
      { id: 'p-1', kind: 'openai', name: '旧网关', baseUrl: 'https://a/v1', model: 'm', strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, contextWindow: 128_000, catalogId: null, hasSecret: true, isDefault: true },
    ]);
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧网关/ }));
    type('模型', 'm2');
    fireEvent.click(screen.getByRole('button', { name: /添加模型/ }));
    expect(screen.getByText('改了还没保存')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /旧网关/ }));
    expect((byLabel('模型') as HTMLInputElement).value).toBe('m2');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(screen.queryByText('改了还没保存')).toBeNull();
  });

  it('typing a field back to what is saved is not a draft', async () => {
    const api = fakeApi([
      { id: 'p-1', kind: 'openai', name: '旧网关', baseUrl: 'https://a/v1', model: 'm', strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, contextWindow: 128_000, catalogId: null, hasSecret: true, isDefault: true },
    ]);
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧网关/ }));
    type('模型', 'm2');
    type('模型', 'm');
    expect(screen.queryByText('改了还没保存')).toBeNull();
  });

  it('deletes only after confirming', async () => {
    const api = fakeApi([
      { id: 'p-1', kind: 'openai', name: '旧网关', baseUrl: 'https://a/v1', model: 'm', strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, contextWindow: 128_000, catalogId: null, hasSecret: true, isDefault: true },
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

  it('上下文上限 is required, and says what to put there', async () => {
    const api = fakeApi();
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    expect(screen.getByText('这个模型一次最多能装多少 token（上下文窗口）。不知道就查服务商的模型说明。')).toBeTruthy();
    type('名称', '公司网关');
    type('接口地址', 'https://api.example.com/v1');
    type('API Key', 'sk-1');
    type('模型', 'deepseek-flash');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('必须填这一项，比如 128000')).toBeTruthy();
    expect(screen.getByText('这个模型一次最多能装多少 token（上下文窗口）。不知道就查服务商的模型说明。')).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
    type(/^上下文上限/, '64000.5');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('填正整数（token 数），比如 128000')).toBeTruthy();
    type(/^上下文上限/, '64000');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-flash', contextWindow: 64_000 })));
  });

  it('fills in 上下文上限 for a model Spica knows; a number typed by hand stays', async () => {
    const api = fakeApi();
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    type('模型', 'claude-sonnet-5-5');
    await waitFor(() => expect((screen.getByLabelText(/^上下文上限/) as HTMLInputElement).value).toBe('1000000'));
    expect(screen.getByText('Spica 认识这个型号，已经填上（100 万），可以改。')).toBeTruthy();
    // Switching to a model it does not know takes the filled-in number away again.
    type('模型', 'deepseek-flash');
    await waitFor(() => expect((screen.getByLabelText(/^上下文上限/) as HTMLInputElement).value).toBe(''));
    type(/^上下文上限/, '64000');
    type('模型', 'claude-sonnet-5-5');
    await new Promise((r) => setTimeout(r, 450));
    expect((screen.getByLabelText(/^上下文上限/) as HTMLInputElement).value).toBe('64000');
  });

  it('a model saved without 上下文上限 says so in the list', async () => {
    const api = fakeApi([
      { id: 'p-1', kind: 'openai', name: '旧网关', baseUrl: 'https://a/v1', model: 'm', strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, contextWindow: null, catalogId: null, hasSecret: true, isDefault: true },
    ]);
    render(<Models api={api} />);
    expect(await screen.findByText('还没填上下文上限，点开补上')).toBeTruthy();
  });

  it('粘贴管理员给的配置 fills the form, switches to WSO2, lists what it cannot place', async () => {
    render(<Models api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: /添加模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '粘贴管理员给的配置' }));
    fireEvent.change(screen.getByLabelText('管理员给的配置'), {
      target: {
        value: ['CONSUMER_KEY=ck-1', 'CONSUMER_SECRET="cs-1"', 'TOKEN_URL=https://gw.example.com/oauth2/token', 'LLM_BASE=https://gw.example.com/llm/v1', 'MODEL=m-1', 'OWNER=IT'].join('\n'),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '识别并填入' }));
    expect(screen.getByRole('radio', { name: 'WSO2 网关' }).getAttribute('aria-checked')).toBe('true');
    expect((byLabel('网关地址') as HTMLInputElement).value).toBe('https://gw.example.com/llm/v1');
    expect((byLabel('取 token 地址') as HTMLInputElement).value).toBe('https://gw.example.com/oauth2/token');
    expect((byLabel('Consumer Key') as HTMLInputElement).value).toBe('ck-1');
    expect((byLabel('Consumer Secret') as HTMLInputElement).value).toBe('cs-1');
    expect((byLabel('模型') as HTMLInputElement).value).toBe('m-1');
    expect(screen.getByText('填好了 5 项：网关地址、取 token 地址、Consumer Key、Consumer Secret、模型。请核对一遍。')).toBeTruthy();
    expect(screen.getByText('OWNER=IT')).toBeTruthy();
    // The pasted text is gone from the window once used.
    expect(screen.queryByLabelText('管理员给的配置')).toBeNull();
  });
});
