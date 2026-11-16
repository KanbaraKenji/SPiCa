// "测试连接" for real, through the core's probe: one minimal request outside
// any session (no retries, 20 s limit). The core returns a category; the words,
// and which field of the form to look at, are written here.
import type { ProviderConfig } from '@spica/core';
import type { ProbeResult } from '@spica/protocol';
import { netWords } from '../../shared/errors';
import { t } from '../../shared/i18n';
import { keyInHeaders, secretLabel, validateDraft, type ProviderDraft } from '../../shared/providers';
import { toProviderConfig } from '../backend/to-config';
import type { ConnectionTester } from './tester';

/** One probe request: the backend process in the app, the core directly in tests. */
export type Probe = (config: ProviderConfig, model: string, timeoutMs: number) => Promise<ProbeResult>;

const TIMEOUT_MS = 20_000;

/**
 * The core's hint in the language now: 获取 token 失败：… / 模型调用失败：… (by the step that failed) and the words
 * for its code (shared/errors.ts netWords); what the shell does not know stays as the core wrote it.
 */
function coreHint(r: ProbeResult, hint: string): string {
  const parts = /^(?:(获取 token 失败)|模型调用失败)：([\s\S]*)$/.exec(hint);
  if (!parts) return netWords(r.code, hint) ?? hint;
  const inner = netWords(r.code, parts[2]!) ?? parts[2]!;
  return parts[1] ? t('获取 token 失败：{hint}', { hint: inner }) : t('模型调用失败：{hint}', { hint: inner });
}

/** The result in words a non-developer can act on, pointing at the field to fix. */
export function probeMessage(r: ProbeResult, draft: Pick<ProviderDraft, 'kind' | 'model'>): string {
  // The core's hints already name the address field as this kind's form does (WSO2: 网关地址).
  if (r.ok && r.suggestedBaseUrl && r.hint) return coreHint(r, r.hint);
  const advice = probeAdvice(r, draft);
  // The core names the cause (获取 token 失败：… / 模型调用失败：…, TLS, proxy...); ours says which field to check.
  // What the core's sentence says is read in its own words (Simplified); what is shown is in the language now.
  const hint = r.ok ? '' : (r.hint ?? '').trim();
  if (!hint) return advice;
  const shown = coreHint(r, hint);
  // The core's sentence already says what to do (「…，请检查 API Key。」, the gateway's fault codes): one sentence, not two.
  const says = r.code?.startsWith('wso2.') || hint.includes('请'); // i18n-skip: the core's words, read
  if (says) return /[。.]$/.test(shown) ? shown : t('{text}。', { text: shown });
  return t('{hint}。{advice}', { hint: shown.replace(/[。.]$/, ''), advice });
}

function probeAdvice(r: ProbeResult, draft: Pick<ProviderDraft, 'kind' | 'model'>): string {
  const model = draft.model.trim();
  const url = draft.kind === 'wso2' ? t('「网关地址」') : t('「接口地址」');
  if (r.ok) {
    const ms = Math.max(1, Math.round(r.firstByteMs ?? r.latencyMs));
    // Say the model the user typed; the server's own name for it (an alias) only as an aside.
    if (r.model && r.model !== model) return t('连接成功：模型「{model}」（响应 {ms} 毫秒，服务端型号：{alias}）。', { model: model || r.model, ms, alias: r.model });
    return t('连接成功：模型「{model}」（响应 {ms} 毫秒）。', { model: model || r.model || '', ms });
  }
  switch (r.errorCode) {
    case 'auth':
      return draft.kind === 'wso2' ? t('获取 token 失败，请检查 Consumer Key、Consumer Secret 和「取 token 地址」。') : keyInHeaders(draft) ? t('密钥无效或已失效，请检查请求头的值。') : t('密钥无效或已失效，请检查 {secret}。', { secret: secretLabel(draft.kind) });
    case 'not_found':
      return t('找不到模型「{model}」或地址无效，请检查模型和{url}。', { model, url });
    case 'bad_request':
      return t('请求被拒绝，请检查模型名「{model}」。', { model });
    case 'rate_limited':
      return t('请求被限流，请稍后重试或调低「同时请求」「每分钟请求」。');
    case 'server':
      return r.httpStatus ? t('模型服务错误（{status}），请稍后重试。', { status: r.httpStatus }) : t('模型服务错误，请稍后重试。');
    case 'network':
      return draft.kind === 'wso2' ? t('连接失败，请检查网络、{url}和「取 token 地址」。', { url }) : t('连接失败，请检查网络和{url}。', { url });
    case 'timeout':
      return t('{s} 秒内无响应，请检查网络和{url}。', { s: TIMEOUT_MS / 1000, url });
    case 'aborted':
      return t('已取消。');
    default:
      return t('连接失败，请检查各项设置。');
  }
}

export function createRealTester(probe: Probe): ConnectionTester {
  return async (draft, savedSecret, _signal, needsKey, headerValues) => {
    const errors = validateDraft(draft, Boolean(savedSecret), { forTest: true, ...(needsKey === false ? { needsKey } : {}) });
    const first = Object.values(errors)[0];
    if (first) return { ok: false, message: first };
    const secret = keyInHeaders(draft) ? '' : draft.secret?.trim() || savedSecret || '';
    const r = await probe(toProviderConfig({ ...draft, id: 'connection-test', secret, ...(headerValues ? { headerValues } : {}) }), draft.model.trim(), TIMEOUT_MS);
    return { ok: r.ok, message: probeMessage(r, draft), ...(r.ok && r.suggestedBaseUrl ? { suggestedBaseUrl: r.suggestedBaseUrl } : {}) };
  };
}
