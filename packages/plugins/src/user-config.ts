// A plugin's user_config (the settings form the app draws for it): fields
// declared in manifest.json, the host stores what the person fills in and hands
// it to the plugin's servers as SPICA_USER_CONFIG (one JSON object). Pure
// functions only: the shell's form uses the same checks as the plugin host.

/** The eight kinds of field. */
export type UserConfigType = 'text' | 'password' | 'number' | 'toggle' | 'select' | 'folder' | 'file' | 'url';
export const USER_CONFIG_TYPES: readonly UserConfigType[] = ['text', 'password', 'number', 'toggle', 'select', 'folder', 'file', 'url'];

/** MCPB's names, read as ours (so a .mcpb manifest can be brought over); our docs only use ours. */
const ALIASES: Record<string, UserConfigType> = { string: 'text', boolean: 'toggle', directory: 'folder' };

export type UserConfigValue = string | number | boolean;

export interface UserConfigField {
  key: string;
  type: UserConfigType;
  title: string;
  placeholder?: string;
  /** MCPB's description: shown on hover beside the label, never as a line under it. */
  description?: string;
  required: boolean;
  default?: UserConfigValue;
  /** select only. */
  options?: string[];
  /** number only. */
  min?: number;
  max?: number;
}

const KEY = /^[a-z][a-z0-9_]{0,31}$/;
/** Key segments that look like a secret: a text field named like this gets a warning (never an error). */
const SECRETISH = new Set(['password', 'passwd', 'pwd', 'token', 'secret', 'key', 'apikey', 'credential', 'credentials']);
const KNOWN = new Set(['type', 'title', 'placeholder', 'description', 'required', 'default', 'options', 'min', 'max', 'sensitive']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeList = USER_CONFIG_TYPES.join('、');

/**
 * Read `user_config` from a manifest. `err` / `warn` take a path under the manifest
 * (`user_config.password.type`) and a sentence for the author. Returns the fields
 * in the order written; a field with an error is left out (the manifest then fails).
 */
export function parseUserConfig(raw: unknown, err: (path: string, message: string) => void, warn: (path: string, message: string) => void): UserConfigField[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) {
    err('user_config', '「user_config」须为对象，每一项一个键，例如 { "server_url": { "type": "url", "title": "服务器地址" } }。');
    return [];
  }
  const out: UserConfigField[] = [];
  for (const [key, spec] of Object.entries(raw)) {
    const at = `user_config.${key}`;
    if (!KEY.test(key)) {
      err(at, `键名「${key}」不合格：小写字母开头，只用小写字母、数字和下划线，最长 32 个字符，例如 server_url。`);
      continue;
    }
    if (!isObj(spec)) {
      err(at, `须为对象，例如 { "type": "text", "title": "名称" }。`);
      continue;
    }
    let bad = false;
    const fail = (path: string, message: string) => {
      bad = true;
      err(path, message);
    };
    for (const k of Object.keys(spec)) if (!KNOWN.has(k)) warn(`${at}.${k}`, `未知属性「${k}」，已忽略。可以写 type、title、placeholder、required、default、options（select）、min / max（number）。`);

    // the type: aliases to our names first, then only our names are checked
    const written = spec.type;
    let type: UserConfigType | undefined;
    if (typeof written !== 'string' || !written) fail(`${at}.type`, `缺少 type，可以写 ${typeList}。`);
    else if ((USER_CONFIG_TYPES as readonly string[]).includes(written)) type = written as UserConfigType;
    else if (ALIASES[written]) type = ALIASES[written];
    else fail(`${at}.type`, `没有 "${written}" 这种类型，可以写 ${typeList}${/secret|sensitive|pass/i.test(written) ? '；密码写 password' : ''}。`);
    const sensitive = spec.sensitive;
    if (type && sensitive !== undefined) {
      if (typeof sensitive !== 'boolean') fail(`${at}.sensitive`, 'sensitive 只能是 true 或 false；密码直接写 "type": "password"。');
      else if (type === 'text' && sensitive) type = 'password';
      else if (type === 'password' && !sensitive) fail(`${at}.sensitive`, 'password 不能写 sensitive: false；不是密码就写 "type": "text"。');
      else if (type !== 'text' && type !== 'password') fail(`${at}.sensitive`, `${type} 不能带 sensitive；密码写 "type": "password"。`);
    }
    if (type && typeof written === 'string' && written !== type) {
      warn(`${at}.type`, `按 ${type} 读了（你写的是 ${written}${sensitive === true ? ' + sensitive' : ''}），这里的写法是 "type": "${type}"。`);
    } else if (type === 'password' && sensitive === true) {
      warn(`${at}.sensitive`, '按 password 读了，sensitive 可以不写。');
    }

    const title = typeof spec.title === 'string' ? spec.title.trim() : '';
    if (!title) fail(`${at}.title`, `缺少 title（表单上这一格的名字），例如 "服务器地址"。`);
    else if (title.length > 40) fail(`${at}.title`, 'title 不能超过 40 个字；更多说明放 placeholder。');
    const placeholder = spec.placeholder;
    if (placeholder !== undefined && typeof placeholder !== 'string') fail(`${at}.placeholder`, 'placeholder 要写成文字。');
    const description = spec.description;
    if (description !== undefined && typeof description !== 'string') fail(`${at}.description`, 'description 要写成文字。');
    const required = spec.required;
    if (required !== undefined && typeof required !== 'boolean') fail(`${at}.required`, 'required 只能是 true 或 false。');

    let options: string[] | undefined;
    if (spec.options !== undefined) {
      if (type !== 'select') fail(`${at}.options`, type === 'text' ? '只有 select 能带 options；要让人从几项里选，写 "type": "select"。' : '只有 select 能带 options。');
      else if (!Array.isArray(spec.options) || spec.options.length === 0 || !spec.options.every((o) => typeof o === 'string' && o.trim())) fail(`${at}.options`, 'options 要写成文字的列表，例如 ["日报", "周报"]。');
      else if (new Set(spec.options).size !== spec.options.length) fail(`${at}.options`, 'options 里有重复的项。');
      else options = spec.options as string[];
    } else if (type === 'select') fail(`${at}.options`, 'select 要写 options，例如 ["日报", "周报"]。');

    const num = (k: 'min' | 'max'): number | undefined => {
      const v = spec[k];
      if (v === undefined) return undefined;
      if (type !== 'number') {
        fail(`${at}.${k}`, `只有 number 能带 ${k}。`);
        return undefined;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        fail(`${at}.${k}`, `${k} 要写数字。`);
        return undefined;
      }
      return v;
    };
    const min = num('min');
    const max = num('max');
    if (min !== undefined && max !== undefined && min > max) fail(`${at}.min`, 'min 不能大于 max。');

    if (bad || !type) continue;
    const field: UserConfigField = {
      key,
      type,
      title,
      required: required === true,
      ...(typeof placeholder === 'string' && placeholder ? { placeholder } : {}),
      ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
      ...(options ? { options } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    };
    if (spec.default !== undefined) {
      if (type === 'password') {
        err(`${at}.default`, '密码不能有默认值（会写进插件包）。');
        continue;
      }
      const d = checkConfigValue(field, spec.default);
      if (!d.ok) {
        err(`${at}.default`, `默认值不合格：${d.message}`);
        continue;
      }
      if (d.value !== null) field.default = d.value;
    }
    if (type !== 'password' && key.split('_').some((s) => SECRETISH.has(s))) warn(`${at}.type`, `「${key}」像是密码或令牌，却是 ${type}：填的值会明文保存、会显示出来。是密码就写 "type": "password"。`);
    out.push(field);
  }
  return out;
}

export type CheckedValue = { ok: true; value: UserConfigValue | null } | { ok: false; message: string };

/**
 * One value for a field, as the form or the store has it: the value to keep
 * (null: empty), or what is wrong in words for the person filling it in.
 * Text is trimmed; a url without a scheme gets https://; a number may come as text.
 */
export function checkConfigValue(field: UserConfigField, raw: unknown): CheckedValue {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  switch (field.type) {
    case 'toggle':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, message: '只能是开或关' };
    case 'number': {
      const t = typeof raw === 'string' ? raw.trim() : raw;
      if (t === '') return { ok: true, value: null };
      const n = typeof t === 'number' ? t : typeof t === 'string' ? Number(t) : Number.NaN;
      if (!Number.isFinite(n)) return { ok: false, message: '请输入数字' };
      if (field.min !== undefined && n < field.min) return { ok: false, message: `不能小于 ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, message: `不能大于 ${field.max}` };
      return { ok: true, value: n };
    }
    default: {
      if (typeof raw !== 'string') return { ok: false, message: '请输入文字' };
      const t = field.type === 'password' ? raw : raw.trim();
      if (!t.trim()) return { ok: true, value: null };
      if (/[\r\n\0]/.test(t) && field.type !== 'text') return { ok: false, message: '不能换行' };
      if (t.length > 4000) return { ok: false, message: '不能超过 4000 个字符' };
      if (field.type === 'select' && !field.options?.includes(t)) return { ok: false, message: `请从 ${field.options?.join('、')} 里选` };
      if (field.type === 'url') {
        const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
        let ok: boolean;
        try {
          const p = new URL(u);
          ok = (p.protocol === 'https:' || p.protocol === 'http:') && Boolean(p.hostname);
        } catch {
          ok = false;
        }
        return ok ? { ok: true, value: u } : { ok: false, message: '请输入以 https:// 开头的网址' };
      }
      return { ok: true, value: t };
    }
  }
}

/**
 * What a server gets as SPICA_USER_CONFIG: every declared key, its stored value
 * if it is still good for the field, else its default, else null.
 */
export function configForServer(fields: readonly UserConfigField[], stored: Readonly<Record<string, unknown>>): Record<string, UserConfigValue | null> {
  const out: Record<string, UserConfigValue | null> = {};
  for (const f of fields) {
    const c = Object.hasOwn(stored, f.key) ? checkConfigValue(f, stored[f.key]) : null;
    out[f.key] = c?.ok && c.value !== null ? c.value : (f.default ?? null);
  }
  return out;
}

/** Required fields with nothing usable (stored, or a default): the plugin waits for them (待设置). */
export function missingConfig(fields: readonly UserConfigField[], stored: Readonly<Record<string, unknown>>): string[] {
  const v = configForServer(fields, stored);
  return fields.filter((f) => f.required && (v[f.key] === null || v[f.key] === '')).map((f) => f.key);
}

/**
 * A log line with a plugin's password values taken out. Values of 6 characters or
 * more go wherever they appear; shorter ones only where no letter or digit sits
 * right before or after them (a very short password cannot be taken out of every
 * word it appears in).
 */
export function scrubSecrets(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (!s) continue;
    if (s.length >= 6) out = out.split(s).join('[redacted]');
    else {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'gu'), '[redacted]');
    }
  }
  return out;
}
