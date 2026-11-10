// "测试连接" on the settings page. For now this is a stand-in that checks the
// form and answers like a gateway would, without sending anything anywhere;
// a real tester (one tiny model call through @spica/core) replaces it later
// behind the same function type.
import { validateDraft, type ProviderDraft, type TestResult } from '../../shared/providers';

export type ConnectionTester = (draft: ProviderDraft, savedSecret: string | undefined, signal?: AbortSignal) => Promise<TestResult>;

export interface FakeTesterOptions {
  /** Pretend network time in ms. Default 700. */
  delayMs?: number;
}

export function createFakeTester({ delayMs = 700 }: FakeTesterOptions = {}): ConnectionTester {
  return async (draft, savedSecret) => {
    const errors = validateDraft(draft, Boolean(savedSecret), { forTest: true });
    const first = Object.values(errors)[0];
    if (first) return { ok: false, message: first };
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const secret = draft.secret?.trim() || savedSecret || '';
    // A few recognisable failures so the error path can be seen without a real gateway.
    if (/bad|wrong|invalid/i.test(secret)) return { ok: false, message: draft.kind === 'wso2' ? '取 token 失败：Consumer Key 或 Consumer Secret 不对。' : '密钥不对或已失效（401）。' };
    if (/\.invalid(\/|$)|localhost:1\b/i.test(draft.baseUrl)) return { ok: false, message: '连不上这个地址，请检查网络或接口地址。' };
    return { ok: true, message: `连得上，模型「${draft.model.trim()}」可以用。` };
  };
}
