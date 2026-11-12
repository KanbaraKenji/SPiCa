// What a company sets when it packages the app: deploy.json next to this
// package (not under version control). Read by electron.vite.config.ts (names
// baked into the build) and scripts/dist.mjs (installer name, appId, icon).
// Without it, or without "app", everything is Spica as published.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetProblems } from '@spica/core';

export const DEFAULT_APP = Object.freeze({ name: 'Spica', id: 'dev.spica.desktop' });

/** Characters Windows does not allow in a file or folder name (the name becomes both). */
const BAD_NAME = /[<>:"/\\|?*]/;
const hasControl = (s) => [...s].some((c) => c.charCodeAt(0) < 32);
const ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * The app's name, id, optional icon and font, and the update source.
 * Throws a plain message when deploy.json is there but wrong, so packaging stops
 * instead of producing a half-renamed app.
 */
export function readDeploy(dir = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const file = join(dir, 'deploy.json');
  if (!existsSync(file)) return { file: null, updateSource: '', pluginSources: [], app: { ...DEFAULT_APP, icon: null, font: null }, models: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`deploy.json 读不了（${err instanceof Error ? err.message : String(err)}）。`, { cause: err });
  }
  const app = raw && typeof raw.app === 'object' && raw.app ? raw.app : {};
  const name = typeof app.name === 'string' && app.name.trim() ? app.name.trim() : DEFAULT_APP.name;
  if (name.length > 40 || BAD_NAME.test(name) || hasControl(name) || /[. ]$/.test(name)) {
    throw new Error(`deploy.json 的 app.name「${name}」不能用：它会成为文件夹和安装包的名字，不能超过 40 个字，不能有 < > : " / \\ | ? *，不能以点或空格结尾。`);
  }
  const id = typeof app.id === 'string' && app.id.trim() ? app.id.trim() : name === DEFAULT_APP.name ? DEFAULT_APP.id : '';
  if (name !== DEFAULT_APP.name && id === DEFAULT_APP.id) {
    throw new Error(`deploy.json 改了 app.name，app.id 也要换一个（不能是 ${DEFAULT_APP.id}），不然会和 Spica 的安装混在一起。`);
  }
  if (!ID.test(id)) {
    throw new Error(
      id
        ? `deploy.json 的 app.id「${id}」不能用：写成 com.example.app 这样，用点隔开的字母、数字和连字符。`
        : 'deploy.json 改了 app.name，也要写 app.id（比如 com.example.app），不然会和 Spica 的安装混在一起。',
    );
  }
  const path = (key) => {
    const v = app[key];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new Error(`deploy.json 的 app.${key} 要写成文件路径。`);
    const p = isAbsolute(v) ? v : resolve(dir, v);
    if (!existsSync(p)) throw new Error(`deploy.json 的 app.${key} 指向的文件不存在：${p}`);
    return p;
  };
  const icon = path('icon');
  if (icon && !icon.toLowerCase().endsWith('.ico')) throw new Error('deploy.json 的 app.icon 要是 .ico 文件（安装包和 exe 只认 .ico）。');
  const font = path('font');
  if (font && !/\.(ttf|otf)$/i.test(font)) throw new Error('deploy.json 的 app.font 要是 .ttf 或 .otf 文件。');
  // The company's preset model connections: checked by the core's own rules; any key or secret stops it.
  const models = raw.models === undefined ? [] : raw.models;
  const problems = presetProblems(models);
  if (problems.length) {
    const list = problems.map((x) => `- ${presetProblemText(x)}`).join('\n');
    throw new Error(`deploy.json 的 models 有 ${problems.length} 处要改：\n${list}`);
  }
  return {
    file,
    updateSource: typeof raw.updateSource === 'string' ? raw.updateSource.trim() : '',
    pluginSources: pluginSourcesOf(raw.pluginSources),
    app: { name, id, icon, font },
    models,
  };
}

/** A place 设置 › 插件 › 市场 can read: a drive or shared folder, or a web address (as 添加来源 takes them). */
const PLACE = /^([a-z]:[\\/]|\\\\|\/\/|https?:\/\/)/i;

/**
 * The official plugin sources (市场, listed first, marked 官方, not removable): each a place, as a string or
 * { "location": …, "label": … }. Wrong ones stop the packaging with a plain message.
 */
function pluginSourcesOf(v) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) throw new Error('deploy.json 的 pluginSources 要写成一个列表，每一项是一个插件来源（地址，或 { "location": 地址, "label": 名字 }）。');
  return v.map((item, i) => {
    const at = `deploy.json 的 pluginSources 第 ${i + 1} 项`;
    const o = typeof item === 'string' ? { location: item } : item && typeof item === 'object' ? item : null;
    if (!o || typeof o.location !== 'string' || !o.location.trim()) throw new Error(`${at}要写地址（字符串，或 { "location": 地址 }）。`);
    const location = o.location.trim();
    if (!PLACE.test(location)) throw new Error(`${at}「${location}」不能用：要写共享盘或本机文件夹（\\\\server\\share、D:\\…）或 http(s) 地址。`);
    if (/^https?:/i.test(location) && /\.zip(\?|$)/i.test(location)) throw new Error(`${at}「${location}」是单个插件包，不能当来源：网址要指向 index.json。`);
    if (o.label !== undefined && typeof o.label !== 'string') throw new Error(`${at}的 label 要写成文字。`);
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    return label ? { location, label } : { location };
  });
}

/** Where, as people count: "models[0] (acme).models[2] (m)" -> 「第 1 个连接（acme）的第 3 个型号（m）」. */
function wherePreset(at) {
  return at
    .replace(/^models\[(\d+)\](?: \(([^)]*)\))?/, (_m, i, id) => `第 ${Number(i) + 1} 个连接${id ? `（${id}）` : ''}`)
    .replace(/\.models\[(\d+)\](?: \(([^)]*)\))?/, (_m, i, id) => `的第 ${Number(i) + 1} 个型号${id ? `（${id}）` : ''}`);
}

const PRESET_WORDS = [
  [/^not an object$/, '要写成 { … } 这样的一项'],
  [/^id missing$/, '缺 id'],
  [/^id used twice$/, 'id 和前面的重复了'],
  [/^name missing$/, '缺 name（列表里显示的名字）'],
  [/^kind must be one of .*$/, 'kind 只能是 openai-compatible、anthropic 或 wso2'],
  [/^baseUrl must be an http\(s\) address$/, 'baseUrl 要以 http:// 或 https:// 开头'],
  [/^tokenUrl .* is needed for wso2$/, 'wso2 要写 tokenUrl（以 http:// 或 https:// 开头）'],
  [/^(\w+) must not be in the packaging.*$/, (k) => `不能写 ${k}：Key 和凭据由每个人自己填，不能放进安装包`],
  [/^models needs at least one model$/, 'models 里至少要有一个型号'],
  [/^contextWindow must be a positive whole number$/, 'contextWindow 要写正整数（这个型号一次最多能装多少 token）'],
  [/^(\w+) must be a positive whole number$/, (k) => `${k} 要写正整数`],
];

/** One of the core's English findings in plain Chinese, saying which entry (English kept when unknown). */
export function presetProblemText(line) {
  if (line === 'models must be a list of model connections') return 'models 要写成一个列表，每一项是一个模型连接';
  const i = line.indexOf(': ');
  if (i < 0) return line;
  const at = line.slice(0, i);
  const what = line.slice(i + 2);
  for (const [re, zh] of PRESET_WORDS) {
    const m = re.exec(what);
    if (m) return `${wherePreset(at)}：${typeof zh === 'function' ? zh(m[1]) : zh}`;
  }
  return `${wherePreset(at)}：${what}`;
}
