// Backend and network errors in words a non-developer can act on. Used by
// the main process (connection test) and the renderer (chat, toasts).
import { N_, t, tx } from './i18n';

/** The provider's account is out of money (402, insufficient balance, quota, arrears): one short line. A key: shown with t(). */
export const BALANCE_WORDS = N_('API 余额不足');

/** Whether words are BALANCE_WORDS, in Simplified or in the language now. */
export function isBalanceWords(words: string | undefined): boolean {
  return words === BALANCE_WORDS || words === t(BALANCE_WORDS);
}

/** A raw backend error as a sentence the user can act on, when it is one of the known causes; undefined otherwise. */
export function knownError(raw: string): string | undefined {
  const m = raw.toLowerCase();
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/.test(m)) return t('模型密钥无效或已失效，请检查 设置 › 模型。');
  if (/\b403\b|forbidden/.test(m)) return t('模型账号无权限，请检查 设置 › 模型。');
  if (/\b404\b|model_not_found|does not exist/.test(m)) return t('找不到模型，请检查模型名称。');
  // before 429: some providers answer an empty account with 429 (insufficient_quota)
  if (/\b402\b|payment required|insufficient|balance|quota|credit|arrear|余额不足|欠费/.test(m)) return t(BALANCE_WORDS);
  if (/\b429\b|rate limit|too many requests/.test(m)) return t('模型接口限流，请稍后重试。');
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable/.test(m)) return t('模型服务错误，请稍后重试。');
  if (/timeout|timed out|etimedout/.test(m)) return t('模型接口超时，请稍后重试。');
  if (/fetch failed|econnrefused|enotfound|network|socket/.test(m)) return t('无法连接模型接口，请检查网络或「接口地址」。');
  if (/reassign needs an existing projectid/.test(m)) return t('项目不存在，请选择其他项目。');
  if (/unknown mail/.test(m)) return t('邮件不存在，请刷新收件箱。');
  if (/unknown project/.test(m)) return t('项目不存在。');
  if (/a project needs a name|project name is required/.test(m)) return t('请填写项目名称。');
  if (/unknown provider/.test(m)) return t('未配置模型，请在 设置 › 模型 中添加。');
  if (/unknown model|invalid model/.test(m)) return t('找不到模型，请检查模型名称。');
  return undefined;
}

/** Turns a raw backend error into a sentence the user can act on. */
export function humanError(raw: string): string {
  return knownError(raw) ?? t('出错：{raw}', { raw });
}

/**
 * The core's words for its network and gateway codes (packages/core net.ts NET_HINTS), word for word, as keys:
 * the interface says them in its own language by code. i18n.test.ts checks that every code is here and the same.
 */
export const NET_WORDS: Readonly<Record<string, string>> = {
  'net.dns': N_('DNS 解析失败，请检查地址或代理设置。'),
  'net.refused': N_('连接被拒绝，请检查地址和端口。'),
  'net.timeout': N_('连接超时，请检查代理或防火墙设置。'),
  'net.reset': N_('连接中断，请检查代理或防火墙设置。'),
  'net.other': N_('网络错误。'),
  'tls.untrusted': N_('证书不受信任，请在「信任的证书文件」中添加企业根证书，或开启「使用 Windows 证书存储」。'),
  'tls.expired': N_('证书已过期或系统时间不正确。'),
  'tls.name_mismatch': N_('证书名称与地址不匹配，请检查地址或代理。'),
  'proxy.unreachable': N_('无法连接代理，请检查代理地址和端口。'),
  'proxy.auth': N_('代理需要身份验证（HTTP 407），请在代理地址中填写用户名和密码。'),
  'proxy.refused': N_('代理拒绝访问该地址，请将其加入「不使用代理的地址」。'),
  'gateway.html': N_('网关返回网页而非接口数据，请检查地址和代理设置。'),
  'gateway.unauthorized': N_('凭据无效（HTTP 401），请检查 API Key。'),
  'gateway.forbidden': N_('无访问权限（HTTP 403），请检查订阅和模型权限。'),
  'gateway.not_found': N_('路径无效（HTTP 404），请检查接口地址和模型名。'),
  'gateway.not_found_version': N_('路径无效（HTTP 404），请检查「接口地址」是否需要以 /v1 结尾。'),
  'address.v1_added': N_('已在「接口地址」末尾补上 /v1，连接成功。'),
  'gateway.bad_request': N_('请求无效（HTTP 400），请检查模型名和参数。'),
  'gateway.rate_limited': N_('请求过于频繁（HTTP 429），请调低「同时请求」。'),
  'gateway.server': N_('服务端错误（HTTP 5xx），请稍后重试。'),
  'gateway.stream_idle': N_('长时间没有收到模型的返回，请稍后重试。'),
  'gateway.bad_response': N_('返回的内容不是模型的回答，请检查「接口地址」。'),
  'wso2.token_unreachable': N_('无法连接取 token 地址。'),
  'wso2.token_rejected': N_('获取 token 被拒绝，请检查 Consumer Key、Consumer Secret 和 Scope。'),
  'wso2.token_bad_response': N_('取 token 地址返回内容无效，请检查地址和代理设置。'),
  'wso2.token_not_accepted': N_('网关拒绝 token，请检查订阅或系统时间。'),
  'wso2.clock_skew': N_('系统时间偏差过大，请校准系统时间。'),
  'list.unsupported': N_('该服务商不支持获取模型列表，请从列表选择或手动输入模型。'),
  'list.bad_response': N_('模型列表格式无效，请从列表选择或手动输入模型。'),
  'wso2.invalid_credentials': N_('凭据无效或 token 已过期（WSO2 900901），请检查 Consumer Key 和 Consumer Secret。'),
  'wso2.missing_credentials': N_('请求缺少凭据（WSO2 900902），请填写 API Key，或将服务商改为公司网关（WSO2）。'),
  'wso2.throttled': N_('调用额度已用完（WSO2 900800–900804），请稍后重试或调低「同时请求」。'),
  'wso2.not_subscribed': N_('应用未订阅此 API（WSO2 900908），请在 WSO2 开发者门户中订阅。'),
  'wso2.scope': N_('token 权限范围不足（WSO2 900910），请在 Scope 中填写所需范围。'),
  'wso2.api_blocked': N_('API 已被网关暂停（WSO2 900907），请联系网关管理员。'),
  'wso2.subscription_inactive': N_('订阅未生效（WSO2 900909），请在 WSO2 开发者门户中查看订阅状态。'),
};

/**
 * Where a WSO2 gateway's words differ (net.ts KIND_HINTS, and the address field named 网关地址 instead of
 * 接口地址), word for word as the core's netHint(code, 'wso2').
 */
export const NET_WORDS_WSO2: Readonly<Record<string, string>> = {
  'gateway.not_found_version': N_('路径无效（HTTP 404），请检查「网关地址」是否包含 API 的路径和版本（如 /llm/1.0）。'),
  'wso2.missing_credentials': N_('请求缺少凭据（WSO2 900902），网关可能还要求在请求头中带 API Key，请向网关管理员确认。'),
  'list.unsupported': N_('网关未提供模型列表，请手动输入模型。'),
  'gateway.not_found': N_('路径无效（HTTP 404），请检查网关地址和模型名。'),
  'address.v1_added': N_('已在「网关地址」末尾补上 /v1，连接成功。'),
  'gateway.bad_response': N_('返回的内容不是模型的回答，请检查「网关地址」。'),
};

/** The words for a code as this kind of connection's form names its fields (shell kind or core kind), as a key. */
export function netWordsKey(code: string | undefined, kind?: string): string | undefined {
  if (!code) return undefined;
  return (kind === 'wso2' ? NET_WORDS_WSO2[code] : undefined) ?? NET_WORDS[code];
}

/**
 * The core's hint for a code in the language now. `core`: the hint the core sent (worded for the connection's
 * kind); its words when the shell knows them, the core's as they are otherwise (a newer core, a prefix). No hint
 * sent: the words for the code.
 */
export function netWords(code: string | undefined, core?: string): string | undefined {
  if (core !== undefined && core.trim()) {
    if (code && (core === NET_WORDS[code] || core === NET_WORDS_WSO2[code])) return t(core);
    return tx(core);
  }
  const key = netWordsKey(code);
  return key ? t(key) : undefined;
}
