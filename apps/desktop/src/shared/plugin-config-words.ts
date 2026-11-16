// What is wrong with a value of a plugin's settings form, in the interface's language. The rules and their words
// are the plugin package's (@spica/plugins/user-config, in Simplified, shared with the plugin kit's copy); the
// fixed ones are looked up word for word, the few with a number or a list in them are matched here.
import { N_, t, tx } from './i18n';

// The fixed messages checkConfigValue can give (tx finds them in the catalogs).
N_('只能是开或关');
N_('请输入数字');
N_('请输入文字');
N_('不能换行');
N_('不能超过 4000 个字符');
N_('请输入以 https:// 开头的网址');

/** checkConfigValue's message in the current language; `options`: the select field's choices. */
export function configProblemText(message: string, options?: readonly string[]): string {
  const min = /^不能小于 (.+)$/.exec(message);
  if (min) return t('不能小于 {min}', { min: min[1]! });
  const max = /^不能大于 (.+)$/.exec(message);
  if (max) return t('不能大于 {max}', { max: max[1]! });
  if (/^请从 .* 里选$/.test(message) && options) return t('请从 {options} 里选', { options: options.join(t('、')) });
  return tx(message);
}
