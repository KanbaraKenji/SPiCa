// Backend and network errors in words a non-developer can act on. Used by
// the main process (connection test) and the renderer (chat, toasts).

/** Turns a raw backend error into a sentence the user can act on. */
export function humanError(raw: string): string {
  const m = raw.toLowerCase();
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/.test(m)) return '模型密钥不对或已失效，请检查模型设置。';
  if (/\b403\b|forbidden/.test(m)) return '这个模型账号没有权限，请检查模型设置。';
  if (/\b404\b|model_not_found|does not exist/.test(m)) return '找不到这个模型，请检查模型名称。';
  if (/\b429\b|rate limit|too many requests/.test(m)) return '模型接口太忙（被限流了），稍后再试。';
  if (/insufficient|balance|quota|credit/.test(m)) return '模型账号余额不足。';
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable/.test(m)) return '模型服务暂时出错了，稍后再试。';
  if (/timeout|timed out|etimedout/.test(m)) return '模型接口太久没有回应，稍后再试。';
  if (/fetch failed|econnrefused|enotfound|network|socket/.test(m)) return '连不上模型接口，请检查网络或接口地址。';
  if (/reassign needs an existing projectid/.test(m)) return '那个项目已经不在了，换一个项目试试。';
  if (/unknown mail/.test(m)) return '这封信已经不在了，刷新一下收件箱。';
  if (/unknown project/.test(m)) return '这个项目已经不在了。';
  if (/a project needs a name|project name is required/.test(m)) return '项目要有个名字。';
  if (/unknown provider/.test(m)) return '还没有配置模型，先到 设置 › 模型 里添加一个。';
  if (/unknown model|invalid model/.test(m)) return '找不到这个模型，请检查模型名称。';
  return `出错了：${raw}`;
}
