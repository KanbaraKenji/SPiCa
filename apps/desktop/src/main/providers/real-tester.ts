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
  const advice = probeAdvice(r, draft);
  // The core names the cause (取 token 失败：… / 调模型失败：…, TLS, proxy...); ours says which field to check.
  const hint = r.ok ? '' : (r.hint ?? '').trim();
  if (!hint) return advice;
  // For a wrong key / model / request ours repeats the core's cause before its colon: keep only what to check.
  const repeats = r.errorCode === 'auth' || r.errorCode === 'not_found' || r.errorCode === 'bad_request';
  const check = repeats ? (/：(请检查.+)$/.exec(advice)?.[1] ?? advice) : advice;
  return `${hint.replace(/[。.]$/, '')}。${check}`;
}

function probeAdvice(r: ProbeResult, draft: Pick<ProviderDraft, 'kind' | 'model'>): string {
  const model = draft.model.trim();
  const url = draft.kind === 'wso2' ? '「网关地址」' : '「接口地址」';
  if (r.ok) {
    const ms = r.firstByteMs ?? r.latencyMs;
    // Say the model the user typed; the server's own name for it (an alias) only as an aside.
    const alias = r.model && r.model !== model ? `，服务端回报的型号是「${r.model}」` : '';
    return `连得上，模型「${model || r.model}」可以用（${Math.max(1, Math.round(ms))} 毫秒开始回应${alias}）。`;
  }
  switch (r.errorCode) {
    case 'auth':
      return draft.kind === 'wso2' ? '取不到 token：请检查「Client ID」和「Client Secret」，以及「取 token 地址」。' : `密钥不对或已失效：请检查「${secretLabel(draft.kind)}」。`;
    case 'not_found':
      return `找不到模型「${model}」或这个地址：请检查「模型」和${url}。`;
    case 'bad_request':
      return `请求被拒绝了，多半是模型名不对：请检查「模型」（现在填的是「${model}」）。`;
    case 'rate_limited':
      return '接口太忙（被限流了），稍后再试；一直这样的话，把「同时请求」「每分钟请求」调小。';
    case 'server':
      return `模型服务出错了${r.httpStatus ? `（${r.httpStatus}）` : ''}，稍后再试。`;
    case 'network':
      return draft.kind === 'wso2' ? `连不上：请检查网络、${url}和「取 token 地址」。` : `连不上：请检查网络和${url}。`;
    case 'timeout':
      return `等了 ${TIMEOUT_MS / 1000} 秒没有回应：请检查网络和${url}。`;
    case 'aborted':
      return '已取消。';
    default:
      return '没有连上，请检查表单里的各项再试一次。';
  }
}

export function createRealTester(probe: Probe): ConnectionTester {
  return async (draft, savedSecret) => {
    const errors = validateDraft(draft, Boolean(savedSecret), { forTest: true });
    const first = Object.values(errors)[0];
    if (first) return { ok: false, message: first };
    const secret = draft.secret?.trim() || savedSecret || '';
    const r = await probe(toProviderConfig({ ...draft, id: 'connection-test', secret }), draft.model.trim(), TIMEOUT_MS);
    return { ok: r.ok, message: probeMessage(r, draft) };
  };
}
