// "测试连接" for real, through the core's probe: one minimal request outside
// any session (no retries, 20 s limit). The core returns a category; the words,
// and which field of the form to look at, are written here.
import type { ProviderConfig } from '@spica/core';
import type { ProbeResult } from '@spica/protocol';
import { secretLabel, validateDraft, type ProviderDraft } from '../../shared/providers';
import { toProviderConfig } from '../backend/to-config';
import type { ConnectionTester } from './tester';

/** One probe request: the backend process in the app, the core directly in tests. */
export type Probe = (config: ProviderConfig, model: string, timeoutMs: number) => Promise<ProbeResult>;

const TIMEOUT_MS = 20_000;

/** The result in words a non-developer can act on, pointing at the field to fix. */
export function probeMessage(r: ProbeResult, draft: Pick<ProviderDraft, 'kind' | 'model'>): string {
  // The core's hints already name the address field as this kind's form does (WSO2: 网关地址).
  if (r.ok && r.suggestedBaseUrl && r.hint) return r.hint;
  const advice = probeAdvice(r, draft);
  // The core names the cause (获取 token 失败：… / 模型调用失败：…, TLS, proxy...); ours says which field to check.
  const hint = r.ok ? '' : (r.hint ?? '').trim();
  if (!hint) return advice;
  // The core's sentence already says what to do (「…，请检查 API Key。」, the gateway's fault codes): one sentence, not two.
  if (r.code?.startsWith('wso2.') || hint.includes('请')) return /[。.]$/.test(hint) ? hint : `${hint}。`;
  return `${hint.replace(/[。.]$/, '')}。${advice}`;
}

function probeAdvice(r: ProbeResult, draft: Pick<ProviderDraft, 'kind' | 'model'>): string {
  const model = draft.model.trim();
  const url = draft.kind === 'wso2' ? '「网关地址」' : '「接口地址」';
  if (r.ok) {
    const ms = r.firstByteMs ?? r.latencyMs;
    // Say the model the user typed; the server's own name for it (an alias) only as an aside.
    const alias = r.model && r.model !== model ? `，服务端型号：${r.model}` : '';
    return `连接成功：模型「${model || r.model}」（响应 ${Math.max(1, Math.round(ms))} 毫秒${alias}）。`;
  }
  switch (r.errorCode) {
    case 'auth':
      return draft.kind === 'wso2' ? '获取 token 失败，请检查 Consumer Key、Consumer Secret 和取 token 地址。' : `密钥无效或已失效，请检查 ${secretLabel(draft.kind)}。`;
    case 'not_found':
      return `找不到模型「${model}」或地址无效，请检查模型和${url}。`;
    case 'bad_request':
      return `请求被拒绝，请检查模型名「${model}」。`;
    case 'rate_limited':
      return '请求被限流，请稍后重试或调低同时请求、每分钟请求。';
    case 'server':
      return `模型服务错误${r.httpStatus ? `（${r.httpStatus}）` : ''}，请稍后重试。`;
    case 'network':
      return draft.kind === 'wso2' ? `连接失败，请检查网络、${url}和取 token 地址。` : `连接失败，请检查网络和${url}。`;
    case 'timeout':
      return `${TIMEOUT_MS / 1000} 秒内无响应，请检查网络和${url}。`;
    case 'aborted':
      return '已取消。';
    default:
      return '连接失败，请检查各项设置。';
  }
}

export function createRealTester(probe: Probe): ConnectionTester {
  return async (draft, savedSecret, _signal, needsKey) => {
    const errors = validateDraft(draft, Boolean(savedSecret), { forTest: true, ...(needsKey === false ? { needsKey } : {}) });
    const first = Object.values(errors)[0];
    if (first) return { ok: false, message: first };
    const secret = draft.secret?.trim() || savedSecret || '';
    const r = await probe(toProviderConfig({ ...draft, id: 'connection-test', secret }), draft.model.trim(), TIMEOUT_MS);
    return { ok: r.ok, message: probeMessage(r, draft), ...(r.ok && r.suggestedBaseUrl ? { suggestedBaseUrl: r.suggestedBaseUrl } : {}) };
  };
}
