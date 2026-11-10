// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreEvent, Message, SettingsChangeMeta } from '@spica/protocol';
import { SettingsChangeCard, settingsChangeRows, settingsChangeTitle } from './SettingsChangeCard';
import { applyEvent, fromHistory } from '../store/transcript';

afterEach(cleanup);

const added: SettingsChangeMeta = {
  action: 'add_connection',
  id: 'p-1',
  name: '测试网关',
  kind: 'wso2',
  baseUrl: 'https://gateway.example.invalid/llm/v1',
  tokenUrl: 'https://gateway.example.invalid/oauth2/token',
  consumerKey: '…1234',
  scope: null,
  models: [
    { id: 'claude-sonnet-5-5', contextWindow: 1_000_000, contextFrom: 'catalog' },
    { id: 'team/claude-opus-5-5', contextWindow: 1_000_000, contextFrom: 'name-match' },
  ],
  addedModels: ['claude-sonnet-5-5', 'team/claude-opus-5-5'],
  changes: ['new', 'default'],
  secret: 'new',
  makeDefault: 'claude-sonnet-5-5',
  test: { ok: false, model: 'claude-sonnet-5-5', code: 'net.dns' },
  by: 'mcp',
  confirmed: false,
  at: '2026-11-10T10:50:00+08:00',
};

const rows = (c: SettingsChangeMeta) => Object.fromEntries(settingsChangeRows(c).map((r) => [r.label, r.value]));

describe('settings-change card (connections)', () => {
  it('a new connection lists everything: each model with its window, name-matched ones said so; the secret only as 新填', () => {
    expect(settingsChangeTitle(added)).toBe('连接到 Spica 的脚本新增了服务商连接「测试网关」');
    expect(rows(added)).toMatchObject({
      类型: 'WSO2 网关',
      网关地址: 'https://gateway.example.invalid/llm/v1',
      'Consumer Key': '末 4 位 1234',
      'claude-sonnet-5-5': '上下文上限 1,000,000 token',
      'team/claude-opus-5-5': '上下文上限 1,000,000 token（按名字对出来的）',
      'Consumer Secret': '新填（已加密保存）',
      新对话默认用: '「测试网关 · claude-sonnet-5-5」',
    });
    expect(JSON.stringify(rows(added))).not.toContain('secret-');
  });

  it('a change says which models were added and removed, and where the default moved', () => {
    const changed: SettingsChangeMeta = {
      ...added,
      action: 'change_connection',
      models: [{ id: 'claude-sonnet-5-5', contextWindow: 1_000_000, contextFrom: 'catalog' }],
      addedModels: [],
      removedModels: ['team/claude-opus-5-5'],
      changes: ['models'],
      secret: 'unchanged',
      makeDefault: undefined,
      defaultMoved: { from: { connectionId: 'p-1', model: 'team/claude-opus-5-5' }, to: { connectionId: 'p-1', model: 'claude-sonnet-5-5' } },
    } as SettingsChangeMeta;
    expect(settingsChangeTitle(changed)).toBe('连接到 Spica 的脚本改了服务商连接「测试网关」');
    expect(rows(changed)).toMatchObject({
      去了模型: 'team/claude-opus-5-5',
      默认模型: '从 「测试网关 · team/claude-opus-5-5」 挪到了 「测试网关 · claude-sonnet-5-5」',
    });
  });

  it('pointing the default or the strong model elsewhere', () => {
    const def: SettingsChangeMeta = { action: 'set_default_model', id: 'p-2', name: 'DeepSeek 2', kind: 'openai-compatible', model: 'deepseek-flash', changes: ['default'], by: 'mcp', confirmed: false, at: added.at };
    expect(settingsChangeTitle(def)).toBe('连接到 Spica 的脚本把新对话默认用的模型换成了「DeepSeek 2 · deepseek-flash」');
    expect(settingsChangeTitle({ ...def, action: 'set_strong_model', model: undefined } as SettingsChangeMeta)).toBe('连接到 Spica 的脚本取消了重活用的模型');
  });

  it('says it was not confirmed and that the test failed; opens 设置 › 模型', () => {
    const open = vi.fn();
    render(<SettingsChangeCard change={added} onOpenSettings={open} />);
    expect(screen.getByRole('note', { name: settingsChangeTitle(added) })).toBeTruthy();
    expect(screen.getByText('没有经过你确认，已经生效')).toBeTruthy();
    expect(screen.getByText(/保存前测试连接没通过/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在设置里查看' }));
    expect(open).toHaveBeenCalled();
  });

  it('the transcript turns the core’s note into the card, live and from history', () => {
    const msg = { id: 'm1', role: 'user', kind: 'note', content: [{ type: 'text', text: 'settings changed' }], createdAt: added.at, meta: { settingsChange: added } } as unknown as Message;
    expect(fromHistory([msg], []).items).toEqual([{ kind: 'settings', id: 'm1', change: added }]);
    const live = applyEvent({ items: [] }, { type: 'message', message: msg, seq: 1, at: added.at, sessionId: 's', parentChain: [] } as CoreEvent);
    expect(live.items).toEqual([{ kind: 'settings', id: 'm1', change: added }]);
  });
});
