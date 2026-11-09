import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../../main/backend/fake';
import { AgentStore, friendlyError } from './agent';

describe('friendlyError', () => {
  it('strips the IPC prefix and translates backend English', () => {
    expect(friendlyError(new Error("Error invoking remote method 'spica:agent': Error: unknown provider: "))).toBe('还没有配置模型，先到 设置 › 模型 里添加一个。');
    expect(friendlyError(new Error("Error invoking remote method 'x': Error: 地址要以 http:// 或 https:// 开头"))).toBe('地址要以 http:// 或 https:// 开头');
  });
});

describe('AgentStore', () => {
  it('does not create a session until the first message is sent', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    store.newChat();
    store.newChat();
    expect(await backend.listSessions()).toHaveLength(0);
    await store.send(null, '你好');
    const sessions = await backend.listSessions();
    expect(sessions).toHaveLength(1);
    expect(store.state.get().activeId).toBe(sessions[0]?.id);
    backend.dispose();
  });
});
