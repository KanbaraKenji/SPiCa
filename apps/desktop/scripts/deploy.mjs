// What a company sets when it packages the app: deploy.json next to this
// package (not under version control). Read by electron.vite.config.ts (names
// baked into the build) and scripts/dist.mjs (installer name, appId, icon).
// Without it, or without "app", everything is Spica as published.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!existsSync(file)) return { file: null, updateSource: '', app: { ...DEFAULT_APP, icon: null, font: null } };
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
  return {
    file,
    updateSource: typeof raw.updateSource === 'string' ? raw.updateSource.trim() : '',
    app: { name, id, icon, font },
  };
}
