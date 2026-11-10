// Backend and network errors in words a non-developer can act on. Used by
// the main process (connection test) and the renderer (chat, toasts).

/** Turns a raw backend error into a sentence the user can act on. */
export function humanError(raw: string): string {
  const m = raw.toLowerCase();
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/.test(m)) return '模型密钥无效或已失效，请检查模型设置。';
  if (/\b403\b|forbidden/.test(m)) return '模型账号无权限，请检查模型设置。';
  if (/\b404\b|model_not_found|does not exist/.test(m)) return '找不到模型，请检查模型名称。';
  if (/\b429\b|rate limit|too many requests/.test(m)) return '模型接口限流，请稍后重试。';
  if (/insufficient|balance|quota|credit/.test(m)) return '模型账号余额不足。';
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable/.test(m)) return '模型服务错误，请稍后重试。';
  if (/timeout|timed out|etimedout/.test(m)) return '模型接口超时，请稍后重试。';
  if (/fetch failed|econnrefused|enotfound|network|socket/.test(m)) return '无法连接模型接口，请检查网络或「接口地址」。';
  if (/reassign needs an existing projectid/.test(m)) return '项目不存在，请选择其他项目。';
  if (/unknown mail/.test(m)) return '邮件不存在，请刷新收件箱。';
  if (/unknown project/.test(m)) return '项目不存在。';
  if (/a project needs a name|project name is required/.test(m)) return '请填写项目名称。';
  if (/unknown provider/.test(m)) return '未配置模型，请在 设置 › 模型 中添加。';
  if (/unknown model|invalid model/.test(m)) return '找不到模型，请检查模型名称。';
  return `出错：${raw}`;
}
