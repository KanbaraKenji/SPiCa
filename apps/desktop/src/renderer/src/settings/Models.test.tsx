// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Models, type ProvidersApi } from './Models';
import type { ProviderList } from '../../../shared/bridge';
import type { ModelCatalogView } from '../../../shared/catalog';
import { emptyDraft, type ProviderDraft, type ProviderView } from '../../../shared/providers';
import { dropAllDrafts } from './drafts';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

const CATALOG: ModelCatalogView = {
  version: 't',
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      group: 'cn',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.example.com/v1',
      docsUrl: 'https://docs.example.com/deepseek',
      listModels: 'openai',
      needsKey: true,
      models: [
        { id: 'deepseek-flash', contextWindow: 128_000, role: 'default', price: { input: 2, output: 8, currency: 'CNY' } },
        { id: 'deepseek-v4-pro', contextWindow: 256_000, role: 'strong' },
      ],
    },
    { id: 'ollama', name: 'Ollama', group: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', listModels: 'ollama', needsKey: false, models: [] },
  ],
};

function fakeApi(initial: ProviderView[] = []) {
  let items = initial;
  const list = (): ProviderList => ({ items, problems: {} });
  const api: ProvidersApi = {
    list: vi.fn(async () => list()),
    save: vi.fn(async (d: ProviderDraft) => {
      const { secret, ...fields } = d;
      const id = d.id ?? `p-${items.length + 1}`;
      const models = fields.models ?? [];
      const view: ProviderView = { ...fields, models, id, keyTail: secret ? secret.slice(-4) : null, hasSecret: Boolean(secret) || Boolean(items.find((i) => i.id === id)?.hasSecret), isDefault: items.length === 0 };
      items = d.id ? items.map((i) => (i.id === id ? view : i)) : [...items, view];
      return list();
    }),
    remove: vi.fn(async (id: string) => {
      items = items.filter((i) => i.id !== id);
      return list();
    }),
    setDefault: vi.fn(async () => list()),
    test: vi.fn(async () => ({ ok: true, message: '连接成功：模型「m」。' })),
    catalog: vi.fn(async () => CATALOG),
    matchWindow: vi.fn(async (_kind, model: string) => (model === 'deepseek-flash-0611' ? { contextWindow: 128_000, matched: 'deepseek-flash', how: 'name' as const } : null)),
  };
  return api;
}

const saved = (over: Partial<ProviderView> = {}): ProviderView => ({
  ...emptyDraft('openai'),
  id: 'p-1',
  name: '旧网关',
  baseUrl: 'https://a.example.com/v1',
  model: 'm',
  contextWindow: 128_000,
  keyTail: null,
  models: [{ id: 'm', contextWindow: 128_000, contextFrom: 'user' }],
  hasSecret: true,
  isDefault: true,
  ...over,
});

// A label's text also holds the hint or error under the field, so match the start of it.
const byLabel = (label: string | RegExp) => screen.getByLabelText(typeof label === 'string' ? new RegExp(`^${label}`) : label);
const type = (label: string | RegExp, value: string) => fireEvent.change(byLabel(label), { target: { value } });
const choose = (value: string) => fireEvent.change(screen.getByLabelText('服务商'), { target: { value } });

async function openNew(api = fakeApi()) {
  render(<Models api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: /添加服务商/ }));
  await waitFor(() => expect(screen.getByLabelText('服务商').querySelectorAll('optgroup').length).toBeGreaterThan(1));
  return api;
}

describe('Models', () => {
  it('a new connection starts from 服务商; the groups and the two others are listed', async () => {
    await openNew();
    const select = screen.getByLabelText('服务商') as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['国内', '本机', '其他']);
    expect([...select.querySelectorAll('optgroup[label="其他"] option')].map((o) => o.textContent)).toEqual(['公司网关（WSO2）', '中转站']);
    expect(screen.queryByLabelText(/^名称/)).toBeNull();
  });

  it('picking a catalog provider fills the name and selects its default model with 上下文上限', async () => {
    await openNew();
    choose('deepseek');
    expect((byLabel('名称') as HTMLInputElement).value).toBe('DeepSeek');
    expect((screen.getByRole('checkbox', { name: /deepseek-flash/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('deepseek-flash 上下文上限') as HTMLInputElement).value).toBe('128000');
    expect(screen.getByText('来自目录')).toBeTruthy();
    // The number says what it is and in what unit.
    expect(screen.getByText('上下文上限')).toBeTruthy();
    expect(screen.getByText('token')).toBeTruthy();
    expect(screen.getByText('输入 ¥2 / 输出 ¥8（每百万 token）')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'API 文档' }).getAttribute('href')).toBe('https://docs.example.com/deepseek');
    // 接口地址 is under 更多选项, already filled in.
    expect(screen.queryByLabelText(/^接口地址/)).toBeNull();
  });

  it('a second connection to the same provider gets its own name', async () => {
    await openNew(fakeApi([saved({ name: 'DeepSeek', catalogId: 'deepseek' })]));
    choose('deepseek');
    expect((byLabel('名称') as HTMLInputElement).value).toBe('DeepSeek 2');
  });

  it('a local provider asks for no key', async () => {
    await openNew();
    choose('ollama');
    expect(screen.queryByLabelText(/^API Key/)).toBeNull();
  });

  it('中转站: 接口地址, 协议 and the key; missing fields are named before testing', async () => {
    const api = await openNew();
    choose('#relay');
    expect(screen.getByRole('radio', { name: 'OpenAI 兼容' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(screen.getByText('请填写名称')).toBeTruthy();
    expect(screen.getByText('请填写接口地址')).toBeTruthy();
    expect(screen.getByText('请至少选择一个模型')).toBeTruthy();
    expect(api.test).not.toHaveBeenCalled();
  });

  it('公司网关（WSO2）: its fields, each with its one standard hint', async () => {
    await openNew();
    choose('#wso2');
    expect(byLabel('网关地址')).toBeTruthy();
    expect(byLabel('取 token 地址')).toBeTruthy();
    expect(byLabel('Consumer Key')).toBeTruthy();
    expect(byLabel('Consumer Secret')).toBeTruthy();
    expect(screen.getByText('模型接口地址，通常以 /v1 结尾，不含 /chat/completions。')).toBeTruthy();
    expect(screen.getByText('即 Client ID，位于 WSO2 开发者门户中应用的 Production Keys。')).toBeTruthy();
    expect(screen.getByText('即 Client Secret，与 Consumer Key 位于同一位置。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(screen.getByText('请填写 Consumer Key')).toBeTruthy();
    expect(screen.getByText('请填写 Consumer Secret')).toBeTruthy();
    expect(screen.getByText('请填写网关地址')).toBeTruthy();
  });

  it('a model typed by hand needs its 上下文上限 before saving', async () => {
    const api = await openNew();
    choose('#relay');
    type('名称', '中转');
    type('接口地址', 'https://relay.example.com/v1');
    type('API Key', 'sk-1');
    type('手动输入模型', 'my-model');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('请填写「my-model」的上下文上限')).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('my-model 上下文上限'), { target: { value: '64000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ models: [{ id: 'my-model', contextWindow: 64_000, contextFrom: 'user' }] })));
  });

  it('a model name the catalog knows by another name gets its 上下文上限, tagged 按名称匹配', async () => {
    await openNew();
    choose('#relay');
    type('手动输入模型', 'deepseek-flash-0611');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect((screen.getByLabelText('deepseek-flash-0611 上下文上限') as HTMLInputElement).value).toBe('128000'));
    expect(screen.getByText('按名称匹配').getAttribute('title')).toBe('deepseek-flash');
  });

  it('tests, saves, and then keeps the key hidden', async () => {
    const api = await openNew();
    choose('deepseek');
    type('API Key', 'sk-1234');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('连接成功：模型「m」。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ catalogId: 'deepseek', model: 'deepseek-flash', contextWindow: 128_000 }));
    expect(screen.getByRole('button', { name: /DeepSeek/ })).toBeTruthy();
    expect(screen.getByText('· 尾号 1234')).toBeTruthy();
    expect((byLabel('API Key') as HTMLInputElement).value).toBe('');
    expect((byLabel('API Key') as HTMLInputElement).placeholder).toBe('已保存（留空不修改）');
  });

  it('keeps the limits under 更多选项, folded, and opens it when something there is wrong', async () => {
    await openNew();
    choose('#relay');
    const more = screen.getByRole('button', { name: '更多选项' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/^同时请求/)).toBeNull();
    fireEvent.click(more);
    expect((byLabel('每分钟请求') as HTMLInputElement).placeholder).toBe('不限');
    type('同时请求', '-3');
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('button', { name: '更多选项' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('须为正整数或留空')).toBeTruthy();
  });

  it('a half-filled form is still there after leaving the page', async () => {
    const api = await openNew();
    choose('deepseek');
    type('API Key', 'sk-1');
    cleanup();
    render(<Models api={api} />);
    await screen.findByText('未保存');
    expect((byLabel('名称') as HTMLInputElement).value).toBe('DeepSeek');
    expect((byLabel('API Key') as HTMLInputElement).value).toBe('sk-1');
  });

  it('each connection keeps its own unsaved edit; saving clears it', async () => {
    const api = fakeApi([saved()]);
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧网关/ }));
    type('名称', '新网关');
    fireEvent.click(screen.getByRole('button', { name: /添加服务商/ }));
    expect(screen.getByText('未保存')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /旧网关/ }));
    expect((byLabel('名称') as HTMLInputElement).value).toBe('新网关');
    type('名称', '旧网关');
    expect(screen.queryByText('未保存')).toBeNull();
  });

  it('deletes only after confirming', async () => {
    const api = fakeApi([saved()]);
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧网关/ }));
    fireEvent.click(screen.getByRole('button', { name: /删除/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('删除服务商「旧网关」？');
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('p-1'));
  });

  it('a connection saved without 上下文上限 says so in the list', async () => {
    render(<Models api={fakeApi([saved({ contextWindow: null, models: [{ id: 'm', contextWindow: null, contextFrom: 'user' }] })])} />);
    expect(await screen.findByText('缺少上下文上限')).toBeTruthy();
  });

  it('粘贴配置 fills the form, switches to 公司网关（WSO2）, lists what it cannot place', async () => {
    await openNew();
    choose('#relay');
    fireEvent.click(screen.getByRole('button', { name: '粘贴配置' }));
    fireEvent.change(screen.getByLabelText('配置文本'), {
      target: {
        value: ['CONSUMER_KEY=ck-1', 'CONSUMER_SECRET="cs-1"', 'TOKEN_URL=https://gw.example.com/oauth2/token', 'LLM_BASE=https://gw.example.com/llm/v1', 'MODEL=m-1', 'OWNER=IT'].join('\n'),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '识别并填入' }));
    expect((screen.getByLabelText('服务商') as HTMLSelectElement).value).toBe('#wso2');
    expect((byLabel('网关地址') as HTMLInputElement).value).toBe('https://gw.example.com/llm/v1');
    expect((byLabel('取 token 地址') as HTMLInputElement).value).toBe('https://gw.example.com/oauth2/token');
    expect((byLabel('Consumer Key') as HTMLInputElement).value).toBe('ck-1');
    expect((byLabel('Consumer Secret') as HTMLInputElement).value).toBe('cs-1');
    expect((screen.getByRole('checkbox', { name: /m-1/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('已填入 5 项：网关地址、取 token 地址、Consumer Key、Consumer Secret、模型')).toBeTruthy();
    expect(screen.getByText('OWNER=IT')).toBeTruthy();
    expect(screen.queryByLabelText('配置文本')).toBeNull();
  });

  it('默认模型 / 强模型 list every selected model by connection and set the pointers', async () => {
    const conn = (id: string, name: string, tail: string, models: string[]): ProviderView =>
      saved({ id, name, keyTail: tail, model: models[0]!, models: models.map((m) => ({ id: m, contextWindow: 1000, contextFrom: 'catalog' as const })), isDefault: id === 'p-1' });
    const items = [conn('p-1', 'DeepSeek', '3f9a', ['deepseek-flash', 'deepseek-v4-pro']), conn('p-2', 'DeepSeek 2', '81c2', ['deepseek-flash'])];
    const api = fakeApi(items);
    const list = { items, problems: {}, default: { connectionId: 'p-1', model: 'deepseek-flash' }, strong: null };
    api.list = vi.fn(async () => list);
    api.setPointer = vi.fn(async () => list);
    render(<Models api={api} />);
    const def = (await screen.findByLabelText('默认模型')) as HTMLSelectElement;
    expect([...def.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['DeepSeek · 尾号 3f9a', 'DeepSeek 2 · 尾号 81c2']);
    // Closed, it still says which connection: two can carry the same model.
    expect(def.selectedOptions[0]?.textContent).toBe('DeepSeek · deepseek-flash');
    const strong = screen.getByLabelText('强模型') as HTMLSelectElement;
    expect(strong.selectedOptions[0]?.textContent).toBe('无');
    fireEvent.change(strong, { target: { value: 'p-1\tdeepseek-v4-pro' } });
    await waitFor(() => expect(api.setPointer).toHaveBeenCalledWith('strong', { connectionId: 'p-1', model: 'deepseek-v4-pro' }));
  });
});
