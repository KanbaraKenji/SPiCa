// "测试连接" for real: one tiny model call with the settings in the form (no
// retries, 20 s limit). Nothing is saved; the key never leaves the main process.
// The core will offer a probe API later; swapping to it only changes this file.
import type { Message } from '@spica/protocol';
import { humanError } from '../../shared/errors';
import { validateDraft } from '../../shared/providers';
import { buildProvider } from '../backend/core';
import type { ConnectionTester } from './tester';

const TIMEOUT_MS = 20_000;

export function createRealTester(): ConnectionTester {
  return async (draft, savedSecret) => {
    const errors = validateDraft(draft, Boolean(savedSecret));
    const first = Object.values(errors)[0];
    if (first) return { ok: false, message: first };
    const secret = draft.secret?.trim() || savedSecret || '';
    const built = buildProvider({ ...draft, id: 'connection-test', secret }, { retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
    if (typeof built === 'string') return { ok: false, message: built };
    const ping: Message = {
      id: 'ping',
      sessionId: 'connection-test',
      seq: 1,
      role: 'user',
      kind: 'user',
      content: [{ type: 'text', text: 'Reply with OK.' }],
      createdAt: new Date().toISOString(),
    };
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      for await (const ev of built.stream({ model: draft.model.trim(), system: '', messages: [ping], tools: [], maxTokens: 16 }, { signal })) {
        if (ev.type === 'response') break;
      }
      return { ok: true, message: `连得上，模型「${draft.model.trim()}」可以用。` };
    } catch (err) {
      if (signal.aborted) return { ok: false, message: '模型接口太久没有回应，稍后再试。' };
      const e = err as { message?: string; status?: number };
      const raw = `${e.status ? `HTTP ${e.status} ` : ''}${e.message ?? String(err)}`;
      return { ok: false, message: humanError(raw) };
    }
  };
}
