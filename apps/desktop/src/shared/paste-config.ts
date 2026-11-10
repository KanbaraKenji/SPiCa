// 「粘贴配置」: an administrator's settings pasted as one block (an .env file,
// a YAML/INI snippet, JSON, a chat message) turned into the model form's
// fields. Keys are matched by keywords, never by any one company's names.
// What it cannot place is listed so the user can put it in by hand. The text
// stays in the window's memory: nothing here writes or logs it.
import type { ProviderDraft, ProviderKind } from './providers';

export type PastedField = 'baseUrl' | 'tokenUrl' | 'clientId' | 'secret' | 'model' | 'scope';

export interface PasteResult {
  fields: Partial<Pick<ProviderDraft, PastedField>>;
  /** Set when the paste clearly is one kind (a token address or a Consumer Key: WSO2). */
  kind?: ProviderKind;
  /** Lines with a value it could not place (as pasted). */
  unknown: string[];
  /** Small fixes it made, in plain words. */
  notes: string[];
}

const isUrl = (v: string) => /^https?:\/\/\S+$/i.test(v);

/** The key in lowercase letters and digits only: WSO2_TOKEN_URL -> wso2tokenurl. */
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which field a key names, by keywords. */
export function fieldForKey(key: string, value: string): PastedField | null {
  const k = norm(key);
  // Chinese keys, the way people write them in a message.
  const zh = key.toLowerCase();
  if (/[一-鿿]/.test(zh)) {
    if (/token/.test(zh) && isUrl(value)) return 'tokenUrl';
    if (/模型/.test(zh) && !isUrl(value)) return 'model';
    if (/(密钥|秘钥|密码)/.test(zh)) return 'secret';
    if (/(网关|接口|地址)/.test(zh) && isUrl(value)) return 'baseUrl';
  }
  if (!k) return null;
  if (k.includes('scope')) return 'scope';
  if (k.includes('token') && /(url|uri|endpoint|address|addr)/.test(k)) return isUrl(value) ? 'tokenUrl' : null;
  if (/(consumerkey|clientid|appid|applicationid|clientkey)/.test(k)) return 'clientId';
  if (/(consumersecret|clientsecret|appsecret|apikey|secretkey|accesskey|secret|password)/.test(k)) return 'secret';
  if (/(model|deployment|engine)/.test(k) && !isUrl(value)) return 'model';
  if (/(base|url|uri|endpoint|host|gateway|api|server)/.test(k)) return isUrl(value) ? 'baseUrl' : null;
  // A bare "key" or "token" (KEY=..., TOKEN=...): most often the API key.
  if (k === 'key' || k.endsWith('key')) return 'secret';
  return null;
}

/** One line as key and value, or null when it is a comment, a heading or empty. */
function splitLine(raw: string): { key: string; value: string } | { value: string } | null {
  let line = raw.trim();
  if (!line || /^(#|\/\/|;|--|rem\s)/i.test(line) || /^\[.*\]$/.test(line) || line === '{' || line === '}') return null;
  line = line.replace(/^(export|set|setx)\s+/i, '').replace(/^\$env:/i, '');
  // Any key (Chinese ones too) before =, : (not the one in https://) or the full-width ：.
  const m = /^["']?([^"'=:：\s][^"'=:：]*?)["']?\s*(?:=|:(?!\/\/)|：)\s*(.*)$/.exec(line);
  if (!m) return isUrl(unquote(line)) ? { value: unquote(line) } : null;
  return { key: m[1]!.trim(), value: unquote(m[2]!) };
}

function unquote(v: string): string {
  const s = v.trim().replace(/,$/, '').trim();
  // A quoted value ends at its closing quote (whatever comment follows).
  const q = /^(["'])(.*?)\1/.exec(s);
  if (q) return q[2]!.trim();
  // Otherwise a trailing " # comment" is not part of it.
  return s.replace(/\s+#.*$/, '').trim();
}

/** Flattens a pasted JSON object into key = value lines (nested keys joined). */
function jsonLines(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const out: string[] = [];
    const walk = (o: unknown, prefix: string) => {
      if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}_${k}` : k);
      else if (typeof o === 'string' || typeof o === 'number') out.push(`${prefix}=${String(o)}`);
    };
    walk(JSON.parse(t), '');
    return out;
  } catch {
    return null;
  }
}

export function parsePastedConfig(text: string): PasteResult {
  const result: PasteResult = { fields: {}, unknown: [], notes: [] };
  const lines = jsonLines(text) ?? text.split(/\r?\n/);
  const bareUrls: string[] = [];
  for (const raw of lines) {
    const part = splitLine(raw);
    if (!part || !part.value) continue;
    if (!('key' in part)) {
      bareUrls.push(part.value);
      continue;
    }
    const field = fieldForKey(part.key, part.value);
    if (!field || result.fields[field] !== undefined) {
      result.unknown.push(raw.trim());
      continue;
    }
    result.fields[field] = part.value;
  }
  // Addresses on their own line: the one about tokens is the token address, another the model address.
  for (const url of bareUrls) {
    const field: PastedField = /token/i.test(url) ? 'tokenUrl' : 'baseUrl';
    if (result.fields[field] === undefined) result.fields[field] = url;
    else result.unknown.push(url);
  }
  const base = result.fields.baseUrl;
  if (base && /\/chat\/completions\/?$/i.test(base)) {
    result.fields.baseUrl = base.replace(/\/chat\/completions\/?$/i, '');
    result.notes.push('地址去掉了结尾的 /chat/completions');
  }
  if (result.fields.tokenUrl || result.fields.clientId) result.kind = 'wso2';
  else if (base && /anthropic\.com/i.test(base)) result.kind = 'anthropic';
  return result;
}
