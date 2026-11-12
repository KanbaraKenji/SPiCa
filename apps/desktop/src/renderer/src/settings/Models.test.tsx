// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentMessagesRow, Models, RunLimitRow, type ProvidersApi } from './Models';
import type { ProviderList } from '../../../shared/bridge';
import type { ModelCatalogView } from '../../../shared/catalog';
import { keyMaskParts, keyMaskText } from '@spica/protocol';
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
      const view: ProviderView = { ...fields, models, id, keyMask: secret ? keyMaskText(keyMaskParts(secret)) : null, hasSecret: Boolean(secret) || Boolean(items.find((i) => i.id === id)?.hasSecret), isDefault: items.length === 0 };
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
  keyMask: null,
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
    // 已启用 on top: the 上下文上限 in short, the full number and where it came from on hover.
    const size = screen.getByRole('button', { name: 'deepseek-flash 上下文上限' });
    expect(size.textContent).toBe('128k');
    expect(size.getAttribute('title')).toBe('上下文上限 128,000 token（来自目录）');
    expect(screen.getByRole('img', { name: 'deepseek-flash 官方价：输入 ¥2 / 输出 ¥8（每百万 token）' }).getAttribute('data-tip')).toBe('输入 ¥2 / 输出 ¥8（每百万 token）');
    // A click on the number edits it.
    fireEvent.click(size);
    expect((screen.getByLabelText('deepseek-flash 上下文上限') as HTMLInputElement).value).toBe('128000');
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
    // Each note in the info icon beside its label (on hover), and read out with the field; the field's name is the label alone.
    expect(byLabel('网关地址').getAttribute('aria-description')).toBe('模型接口地址，通常以 /v1 结尾，不含 /chat/completions。');
    expect(byLabel('Consumer Key').getAttribute('aria-description')).toBe('即 Client ID，位于 WSO2 开发者门户中应用的 Production Keys。');
    expect(byLabel('Consumer Secret').getAttribute('aria-description')).toBe('即 Client Secret，与 Consumer Key 位于同一位置。');
    expect([...document.querySelectorAll('.info-tip')].map((t) => t.getAttribute('data-tip'))).toContain('即 Client Secret，与 Consumer Key 位于同一位置。');
    // Not a line under the field any more: only inside the info icon.
    expect(screen.queryByText('模型接口地址，通常以 /v1 结尾，不含 /chat/completions。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(screen.getByText('请填写 Consumer Key')).toBeTruthy();
    expect(screen.getByText('请填写 Consumer Secret')).toBeTruthy();
    expect(screen.getByText('请填写网关地址')).toBeTruthy();
  });

  it('the name field’s example is the preset picked, none for 中转站', async () => {
    await openNew();
    choose('deepseek');
    expect((byLabel('名称') as HTMLInputElement).placeholder).toBe('DeepSeek');
    choose('#relay');
    expect((byLabel('名称') as HTMLInputElement).placeholder).toBe('');
  });

  it('a model typed by hand needs its 上下文上限 before saving', async () => {
    const api = await openNew();
    choose('#relay');
    type('名称', '中转');
    type('接口地址', 'https://relay.example.com/v1');
    type('API Key', 'sk-1');
    fireEvent.click(screen.getByRole('button', { name: '手动输入模型' }));
    type('手动输入模型', 'my-model');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('请填写「my-model」的上下文上限')).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
    // The first 保存 has finished (one submit at a time).
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('my-model 上下文上限'), { target: { value: '64000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ models: [{ id: 'my-model', contextWindow: 64_000, contextFrom: 'user' }] })));
  });

  it('a model name the catalog knows by another name gets its 上下文上限, tagged 按名称匹配', async () => {
    await openNew();
    choose('#relay');
    fireEvent.click(screen.getByRole('button', { name: '手动输入模型' }));
    type('手动输入模型', 'deepseek-flash-0611');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'deepseek-flash-0611 上下文上限' }).textContent).toBe('128k'));
    expect(screen.getByRole('button', { name: 'deepseek-flash-0611 上下文上限' }).getAttribute('title')).toBe('上下文上限 128,000 token（按名称匹配：deepseek-flash）');
  });

  it('保存 clicked three times saves once', async () => {
    const api = await openNew();
    choose('deepseek');
    type('API Key', 'sk-abcdefghijklmnopqrstu1234');
    const save = screen.getByRole('button', { name: '保存' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('获取模型列表 says how many it got and how many are new, until the next change', async () => {
    const api = fakeApi();
    api.listModels = vi.fn(async () => ({
      ok: true as const,
      models: [
        { id: 'deepseek-flash', inCatalog: true, chat: true },
        { id: 'deepseek-v4-pro', inCatalog: true, chat: true },
        { id: 'deepseek-chat', inCatalog: false, chat: true },
        { id: 'text-embed', inCatalog: false, chat: false },
      ],
    }));
    await openNew(api);
    choose('deepseek');
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    expect((await screen.findByRole('status')).textContent).toBe('已获取 3 个模型，新增 1 个');
    // Again: nothing new this time.
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已获取 3 个模型，没有新增'));
    // Any change to the form clears it, as 已保存 is cleared.
    type('名称', 'DeepSeek 备用');
    expect(screen.queryByText(/已获取/)).toBeNull();
  });

  it('tests, saves, and then keeps the key hidden', async () => {
    const api = await openNew();
    choose('deepseek');
    type('API Key', 'sk-abcdefghijklmnopqrstu1234');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('连接成功：模型「m」。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ catalogId: 'deepseek', model: 'deepseek-flash', contextWindow: 128_000 }));
    expect(screen.getByRole('button', { name: /DeepSeek/ })).toBeTruthy();
    // First and last characters, the middle hidden.
    expect(screen.getByText('sk-a****1234')).toBeTruthy();
    expect((byLabel('API Key') as HTMLInputElement).value).toBe('');
    expect((byLabel('API Key') as HTMLInputElement).placeholder).toBe('已保存（留空不修改）');
  });

  it('a test that only got through with /v1 added puts that address in the form, and saving keeps it', async () => {
    const api = await openNew();
    api.test = vi.fn(async () => ({ ok: true, message: '已在「接口地址」末尾补上 /v1，连接成功。', suggestedBaseUrl: 'https://relay.example.com/v1' }));
    choose('#relay');
    type('名称', '中转');
    type('接口地址', 'https://relay.example.com');
    type('API Key', 'sk-1');
    fireEvent.click(screen.getByRole('button', { name: '手动输入模型' }));
    type('手动输入模型', 'm');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByLabelText('m 上下文上限'), { target: { value: '64000' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('已在「接口地址」末尾补上 /v1，连接成功。')).toBeTruthy();
    expect((byLabel('接口地址') as HTMLInputElement).value).toBe('https://relay.example.com/v1');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://relay.example.com/v1' })));
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
    // Marked in the list and beside 保存.
    expect(await screen.findAllByText('未保存')).toHaveLength(2);
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

  it('unchecking keeps a model in the list (check it back); 删除 takes it out; the catalog’s cannot be deleted', async () => {
    const api = fakeApi([saved({ name: 'DeepSeek', catalogId: 'deepseek', models: [{ id: 'deepseek-flash', contextWindow: 128_000, contextFrom: 'catalog' }, { id: 'my-model', contextWindow: 64_000, contextFrom: 'user' }] })]);
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    // Unchecked: it moves down to 未启用, where a click turns it on again.
    fireEvent.click(screen.getByRole('checkbox', { name: /my-model/ }));
    expect(screen.queryByRole('checkbox', { name: /my-model/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '启用 my-model' }));
    expect((screen.getByRole('checkbox', { name: /my-model/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('button', { name: '删除 deepseek-flash' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /my-model/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ models: [expect.objectContaining({ id: 'deepseek-flash' }), expect.objectContaining({ id: 'my-model', enabled: false })] })));
    fireEvent.click(screen.getByRole('button', { name: '删除 my-model' }));
    expect(screen.queryByRole('button', { name: '启用 my-model' })).toBeNull();
  });

  it('beside 保存: 未保存 while there are changes, and 取消 goes back to what is saved', async () => {
    render(<Models api={fakeApi([saved()])} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧网关/ }));
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    type('名称', '新网关');
    expect(screen.getAllByText('未保存').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect((byLabel('名称') as HTMLInputElement).value).toBe('旧网关');
    expect(screen.queryByText('未保存')).toBeNull();
  });

  it('unchecking the model 默认模型 points at says where it goes when saved', async () => {
    const item = saved({ name: 'DeepSeek', models: [{ id: 'a', contextWindow: 1000, contextFrom: 'user' }, { id: 'b', contextWindow: 1000, contextFrom: 'user' }] });
    const api = fakeApi([item]);
    api.list = vi.fn(async () => ({ items: [item], problems: {}, default: { connectionId: 'p-1', model: 'a' }, strong: null }));
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^a/ }));
    expect(screen.getByText('保存后，默认模型将改为「DeepSeek · b」。')).toBeTruthy();
  });

  it('deletes only after confirming', async () => {
    const api = fakeApi([saved()]);
    render(<Models api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /旧网关/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('删除服务商「旧网关」？');
    expect(dialog.textContent).toContain('使用该服务商的对话，下次发消息时需重新选择模型；已保存的 Key 一并删除。');
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
      saved({ id, name, keyMask: tail, model: models[0]!, models: models.map((m) => ({ id: m, contextWindow: 1000, contextFrom: 'catalog' as const })), isDefault: id === 'p-1' });
    const items = [conn('p-1', 'DeepSeek', 'sk-a****3f9a', ['deepseek-flash', 'deepseek-v4-pro']), conn('p-2', 'DeepSeek 2', 'sk-b****81c2', ['deepseek-flash'])];
    const api = fakeApi(items);
    const list = { items, problems: {}, default: { connectionId: 'p-1', model: 'deepseek-flash' }, strong: null };
    api.list = vi.fn(async () => list);
    api.setPointer = vi.fn(async () => list);
    render(<Models api={api} />);
    const def = (await screen.findByLabelText('默认模型')) as HTMLSelectElement;
    expect([...def.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['DeepSeek · sk-a****3f9a', 'DeepSeek 2 · sk-b****81c2']);
    // Closed, it still says which connection: two can carry the same model.
    expect(def.selectedOptions[0]?.textContent).toBe('DeepSeek · deepseek-flash');
    const strong = screen.getByLabelText('强模型') as HTMLSelectElement;
    expect(strong.selectedOptions[0]?.textContent).toBe('无');
    fireEvent.change(strong, { target: { value: 'p-1\tdeepseek-v4-pro' } });
    await waitFor(() => expect(api.setPointer).toHaveBeenCalledWith('strong', { connectionId: 'p-1', model: 'deepseek-v4-pro' }));
  });
});

describe('context window in short', () => {
  it('reads the way providers write it', async () => {
    const { windowText } = await import('./ModelPicker');
    expect(windowText(128_000)).toBe('128k');
    expect(windowText(131_072)).toBe('128k');
    expect(windowText(1_048_576)).toBe('1M');
    expect(windowText(1_000_000)).toBe('1M');
    expect(windowText(200_000)).toBe('200k');
    expect(windowText(32_768)).toBe('32k');
    expect(windowText(64_500)).toBe('64.5k');
  });
});

describe('two connections with one name', () => {
  it('默认模型 and 强模型 list both, each under its own heading, and React is given no duplicate key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const name = '开发用模型（.env.local）';
    render(<Models api={fakeApi([saved({ id: 'openai', name, readOnly: true }), saved({ id: 'anthropic', kind: 'anthropic', name, readOnly: true, isDefault: false, model: 'n', models: [{ id: 'n', contextWindow: 200_000, contextFrom: 'user' }] })])} />);
    const pick = (await screen.findByLabelText('默认模型')) as HTMLSelectElement;
    expect([...pick.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([name, name]);
    expect([...pick.querySelectorAll('option')].map((o) => o.textContent)).toEqual([`${name} · m`, `${name} · n`]);
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('same key'))).toEqual([]);
    errors.mockRestore();
  });
});

describe('a name already in use', () => {
  it('is refused on saving, under the 名称 field, in the page’s own error style; another name saves', async () => {
    const api = await openNew(fakeApi([saved({ name: '旧网关' })]));
    choose('#relay');
    type('名称', '旧网关');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const error = await screen.findByText('名称已存在');
    expect(error.className).toContain('field-error');
    expect(byLabel('名称').getAttribute('aria-invalid')).toBe('true');
    expect(api.save).not.toHaveBeenCalled();
    type('名称', '新网关');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByText('名称已存在')).toBeNull());
  });
});

describe('单次运行花费上限', () => {
  it('empty says 不限 (the default); a valid amount applies at once; empty again is no limit', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RunLimitRow value={null} onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: '单次运行花费上限（美元）' }) as HTMLInputElement;
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('不限');
    expect(screen.getByText(/一次运行是从发出一条消息到这一轮做完/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '2.5' } });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
    rerender(<RunLimitRow value={2.5} onChange={onChange} />);
    fireEvent.change(box, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('what is not an amount is kept in the box, not saved, and says why once you leave it', () => {
    const onChange = vi.fn();
    render(<RunLimitRow value={null} onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: '单次运行花费上限（美元）' });
    fireEvent.change(box, { target: { value: '0' } });
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(screen.getByText('须为大于 0 的金额')).toBeTruthy();
  });

  it('is on the page when the settings give it', async () => {
    render(<Models api={fakeApi()} runLimit={{ value: 1, onChange: () => undefined }} />);
    expect((screen.getByRole('textbox', { name: '单次运行花费上限（美元）' }) as HTMLInputElement).value).toBe('1');
  });
});

describe('代理互发消息上限', () => {
  it('shows the number (10 by default), applies a valid one at once, empty is 不限; not a whole number stays and says why', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AgentMessagesRow value={10} onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: '代理互发消息上限（条）' }) as HTMLInputElement;
    expect(box.value).toBe('10');
    expect(box.placeholder).toBe('不限');
    expect(screen.getByText(/你说一句话之后，一个对话最多给别的代理发这么多条消息/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith(5);
    rerender(<AgentMessagesRow value={5} onChange={onChange} />);
    fireEvent.change(box, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    onChange.mockClear();
    fireEvent.change(box, { target: { value: '2.5' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(screen.getByText('须为 1 到 1000 的整数')).toBeTruthy();
  });

  it('sits with 单次运行花费上限 in one group', () => {
    render(<Models api={fakeApi()} runLimit={{ value: null, onChange: () => undefined }} agentMessages={{ value: 10, onChange: () => undefined }} />);
    expect(screen.getByRole('heading', { name: '上限' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '代理互发消息上限（条）' })).toBeTruthy();
  });
});
