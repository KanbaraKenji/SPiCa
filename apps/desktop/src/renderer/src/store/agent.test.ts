import { describe, expect, it, vi } from 'vitest';
import { FakeBackend } from '../../../main/backend/fake';
import { AgentStore, cwdErrorText, displayTitle, friendlyError } from './agent';
import type { SessionInfo } from '@spica/protocol';

describe('friendlyError', () => {
  it('strips the IPC prefix and translates backend English', () => {
    expect(friendlyError(new Error("Error invoking remote method 'spica:agent': Error: unknown provider: "))).toBe('未配置模型，请在 设置 › 模型 中添加。');
    expect(friendlyError(new Error("Error invoking remote method 'x': Error: 地址须以 http:// 或 https:// 开头"))).toBe('地址须以 http:// 或 https:// 开头');
  });
});

describe('conversation names', () => {
  // The core's standing conversation (getTopSession) is named like any other: no special 助理.
  const top = { id: 'ses_top', title: null } as unknown as SessionInfo;
  it('by the first thing said, 新对话 before anything is said', () => {
    expect(displayTitle(top, {})).toBe('新对话');
    expect(displayTitle(top, { ses_top: '帮我看看工作文件夹里有哪些文件' })).toBe('帮我看看工作文件夹里有哪些文件');
  });
});

describe('AgentStore', () => {
  it('keeps every file card of a call across the reload after a run (they only arrive as events)', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    // Stored history without the lists (as when the event came but the stored meta has only the first card).
    const getMessages = backend.getMessages.bind(backend);
    backend.getMessages = async (...args: Parameters<typeof getMessages>) =>
      (await getMessages(...args)).map((m) => {
        if (!m.meta?.fileCardLists) return m;
        const { fileCardLists, ...meta } = m.meta;
        void fileCardLists;
        return { ...m, meta };
      });
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    await store.send(null, '把报价汇总一下');
    const id = store.state.get().activeId!;
    await vi.waitFor(() => {
      const t = store.state.get().transcripts[id];
      expect(t?.lastRun).toBeTruthy();
      expect(Object.values(t?.fileCardLists ?? {}).some((l) => l.length === 8)).toBe(true);
    });
  });

  it('does not create a session until the first message is sent', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    // The core makes the assistant's default thread itself; 新对话 adds nothing until you write.
    const top = await backend.getTopSession();
    store.newChat();
    store.newChat();
    expect((await backend.listSessions()).map((x) => x.id)).toEqual([top.id]);
    // First use: the message goes into the assistant's still-empty thread, no extra one.
    await store.send(null, '你好');
    expect((await backend.listSessions()).map((x) => x.id)).toEqual([top.id]);
    expect(store.state.get().activeId).toBe(top.id);
    // After that, 新对话 starts a new conversation.
    store.newChat();
    await store.send(null, '再开一个');
    const sessions = await backend.listSessions();
    expect(sessions).toHaveLength(2);
    expect(store.state.get().activeId).toBe(sessions.find((x) => x.id !== top.id)?.id);
    backend.dispose();
  });

  it('opens on the empty window while nothing was said, and the first message uses 默认模型 as it is now', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    const top = await backend.getTopSession();
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    expect(store.state.get().activeId).toBeNull();
    // 默认模型 was changed after the thread was made.
    store.setDefaultModel({ providerId: 'p-2', model: 'deepseek-v4-pro' });
    await store.send(null, '你好');
    expect(store.state.get().activeId).toBe(top.id);
    const now = await backend.getSession(top.id);
    expect([now?.providerId, now?.model]).toEqual(['p-2', 'deepseek-v4-pro']);
    backend.dispose();
  });

  it('names untitled conversations by their first line after a restart', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    const first = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await first.init();
    await first.send(null, '你好');
    first.newChat();
    await first.send(null, '帮我看看报价单');
    // A fresh window over the same core (the app was closed and opened again).
    const again = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await again.init();
    await vi.waitFor(() => expect(Object.values(again.state.get().firstLines).sort()).toEqual(['你好', '帮我看看报价单']));
    backend.dispose();
  });

  it('renames and deletes a project; its conversations leave the list, not just the project', async () => {
    const backend = new FakeBackend({ speed: 0 });
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    await vi.waitFor(() => expect(store.state.get().projects.length).toBe(2));
    expect(await store.renameProject('p-budget', '  ')).toBe('请填写项目名称。');
    expect(await store.renameProject('p-budget', '2027 年度预算')).toBeNull();
    expect(store.state.get().sessions.find((x) => x.id === 's-pm-2')?.title).toBe('2027 年度预算');
    await store.open('s-w-4');
    expect(await store.deleteProject('p-budget')).toBeNull();
    const v = store.state.get();
    expect(v.projects.map((p) => p.id)).toEqual(['p-review']);
    expect(v.sessions.some((x) => x.id === 's-pm-2' || x.id === 's-w-4')).toBe(false);
    // The open conversation was in it: back to the assistant.
    expect(v.activeId).toBe(v.topId);
    backend.dispose();
  });
});

describe('deleting a conversation and choosing its working folder', () => {
  it('deletes the open conversation: it leaves the list and the window goes to a new conversation', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    await store.send(null, '你好');
    const id = store.state.get().activeId!;
    expect(await store.deleteSession(id)).toBeNull();
    await vi.waitFor(() => expect(store.state.get().sessions.some((x) => x.id === id)).toBe(false));
    expect(store.state.get().activeId).toBeNull();
  });

  it('a project manager is not deleted on its own: what went wrong is said', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    const p = await backend.createProject!({ name: '样机评审' });
    expect(await store.deleteSession(p.managerSessionId)).not.toBeNull();
  });

  it('chooses the folder once; a refusal is said in the window’s words', async () => {
    const backend = new FakeBackend({ speed: 0, seed: false });
    const store = new AgentStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
    await store.init();
    await store.send(null, '你好');
    const id = store.state.get().activeId!;
    // Not while it runs.
    await vi.waitFor(async () => expect((await backend.getSession(id))?.status).toBe('idle'));
    expect(store.state.get().sessions.find((x) => x.id === id)?.canChooseCwd).toBe(true);
    expect(await store.chooseCwd(id, 'D:/资料/报价')).toBeNull();
    const after = store.state.get().sessions.find((x) => x.id === id);
    expect([after?.cwd, after?.canChooseCwd]).toEqual(['D:/资料/报价', false]);
    expect(await store.chooseCwd(id, 'D:/别处')).toBe('工作文件夹已选定，不能更改。');
    expect(store.state.get().notice).toBe('工作文件夹已选定，不能更改。');
  });

  it('says each refusal in standard words; a failed move names the file and what could not be put back', () => {
    const r = (code: 'cwd.not_changeable' | 'cwd.busy' | 'cwd.bad_folder' | 'cwd.move_failed', more = {}) => cwdErrorText({ ok: false, code, message: 'x', ...more });
    expect(r('cwd.busy')).toBe('对话进行中，结束后再选择工作文件夹。');
    expect(r('cwd.bad_folder')).toBe('无法使用该文件夹，请选择其他文件夹。');
    expect(r('cwd.move_failed', { file: 'C:/data/ses_1/报价.xlsx' })).toBe('移动「报价.xlsx」失败，已放回原处，工作文件夹未更改。');
    expect(r('cwd.move_failed', { file: 'C:\\data\\a.txt', notRestored: ['C:\\data\\b.txt'] })).toBe('移动「a.txt」失败，已放回原处，工作文件夹未更改；1 个文件未能放回：b.txt。');
  });
});
