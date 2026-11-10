// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreEvent, Message, SettingsChangeMeta } from '@spica/protocol';
import { SettingsChangeCard, settingsChangeRows, settingsChangeTitle } from './SettingsChangeCard';
import { applyEvent, fromHistory } from '../store/transcript';

afterEach(cleanup);

const added: SettingsChangeMeta = {
  action: 'add_model',
  id: 'p-1',
  name: '测试网关',
  kind: 'wso2',
  model: 'claude-sonnet-5-5',
  baseUrl: 'https://gateway.example.invalid/llm/v1',
  tokenUrl: 'https://gateway.example.invalid/oauth2/token',
  consumerKey: '…1234',
  scope: null,
  contextWindow: 1_000_000,
  changes: ['new', 'default'],
  secret: 'new',
  makeDefault: true,
  test: { ok: false, code: 'net.dns' },
  by: 'mcp',
  confirmed: false,
  at: '2026-11-10T10:50:00+08:00',
};

describe('settings-change card', () => {
  it('a new connection lists everything, the secret only as 新填, the key by its last 4', () => {
    expect(settingsChangeTitle(added)).toBe('连接到 Spica 的脚本新增了模型连接「测试网关」');
    const rows = Object.fromEntries(settingsChangeRows(added).map((r) => [r.label, r.value]));
    expect(rows).toMatchObject({
      类型: 'WSO2 网关',
      网关地址: 'https://gateway.example.invalid/llm/v1',
      '取 token 地址': 'https://gateway.example.invalid/oauth2/token',
      'Consumer Key': '末 4 位 1234',
      模型: 'claude-sonnet-5-5',
      上下文上限: '1,000,000 token',
      'Consumer Secret': '新填（已加密保存）',
      默认模型: '设成了默认',
    });
    expect(JSON.stringify(rows)).not.toContain('secret-');
  });

  it('a change lists only what changed', () => {
    const changed: SettingsChangeMeta = { ...added, action: 'change_model', changes: ['contextWindow'], secret: 'unchanged', makeDefault: false };
    expect(settingsChangeTitle(changed)).toBe('连接到 Spica 的脚本改了模型连接「测试网关」');
    expect(settingsChangeRows(changed)).toEqual([{ label: '上下文上限', value: '1,000,000 token' }]);
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
