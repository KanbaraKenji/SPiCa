#!/usr/bin/env node
// Create a new Spica plugin folder: manifest, a Node MCP server with error
// codes and mock data, tests (node:test), and optionally a skill, a command,
// a hook and a page.
//
//   node scaffold.mjs <name> [--dir <parent folder>] [--display "Title"]
//                     [--description "..."] [--author "..."]
//                     [--with skill,command,hook,ui] [--with-ui]
//                     [--placement sidebar|panel|settings] [--force]
//
// The page (ui) goes in the sidebar by default; --placement panel puts it in
// a panel beside the conversation instead, --placement settings in the
// plugin's own detail under 设置 › 插件 (a settings page, no sidebar entry).
//
// <name>: lowercase letters, digits and "-", 2–24 characters; it becomes the
// tool prefix (<name>__list_items) and should not change later.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const NAME = /^[a-z][a-z0-9-]{1,23}$/;
const EXTRAS = ['skill', 'command', 'hook', 'ui'];

function parse(argv) {
  const o = { with: new Set(), force: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 后面要跟一个值`);
      return v;
    };
    if (a === '--dir') o.dir = val();
    else if (a === '--display') o.display = val();
    else if (a === '--description') o.description = val();
    else if (a === '--author') o.author = val();
    else if (a === '--with') for (const w of val().split(',').map((s) => s.trim()).filter(Boolean)) o.with.add(w);
    else if (a === '--with-ui') o.with.add('ui');
    else if (a === '--placement') o.placement = val();
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else rest.push(a);
  }
  o.name = rest[0];
  return o;
}

export async function scaffold(opts) {
  const name = opts.name;
  if (!name || !NAME.test(name)) throw new Error('插件名只能用小写字母、数字和 -，以字母开头，2–24 个字符，例如 todo 或 team-board。');
  for (const w of opts.with ?? []) if (!EXTRAS.includes(w)) throw new Error(`--with 只认 ${EXTRAS.join('、')}，没有 ${w}。`);
  const root = resolve(opts.dir ?? '.', name);
  if (existsSync(root) && (await readdir(root)).length > 0 && !opts.force) {
    throw new Error(`${root} 已经存在而且不是空的。换个名字，或加 --force 覆盖模板文件。`);
  }
  const display = opts.display ?? name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const description = opts.description ?? `Keep a simple list of items in ${display}.`;
  const author = opts.author ?? 'Your Name';
  const withs = new Set(opts.with ?? []);
  const hooks = withs.has('hook') ? '"inject"' : '';
  const placement = opts.placement ?? 'sidebar';
  if (!['sidebar', 'panel', 'settings'].includes(placement)) throw new Error('--placement 只能是 sidebar（侧栏）、panel（对话旁边的面板）或 settings（设置 › 插件 里这个插件的设置页）。');
  if (opts.placement && !withs.has('ui')) withs.add('ui');
  // Inside JSON files the values are escaped as JSON strings; elsewhere they go in as typed.
  const fill = (text, json) => {
    const v = (s) => (json ? JSON.stringify(s).slice(1, -1) : s);
    return text
      .replaceAll('__NAME__', name)
      .replaceAll('__DISPLAY__', v(display))
      .replaceAll('__DESCRIPTION__', v(description))
      .replaceAll('__AUTHOR__', v(author))
      .replaceAll('__HOOKS__', hooks)
      .replaceAll('__PLACEMENT__', placement);
  };

  const files = [
    ['manifest.json.tmpl', 'manifest.json'],
    ['icon-light.svg.tmpl', 'icon-light.svg'],
    ['icon-dark.svg.tmpl', 'icon-dark.svg'],
    ['package.json.tmpl', 'package.json'],
    ['spicaignore.tmpl', '.spicaignore'],
    ['README.md.tmpl', 'README.md'],
    ['mcp.json.tmpl', `mcp/${name}.json`],
    ['server/index.js.tmpl', 'server/index.js'],
    ['server/tools.js.tmpl', 'server/tools.js'],
    ['server/errors.js.tmpl', 'server/errors.js'],
    ['server/backend.js.tmpl', 'server/backend.js'],
    ['items.json.tmpl', 'mock/items.json'],
    ['server.test.mjs.tmpl', 'test/server.test.mjs'],
  ];
  if (withs.has('skill')) files.push(['extras/SKILL.md.tmpl', `skills/${name}-basics/SKILL.md`]);
  if (withs.has('command')) files.push(['extras/command.md.tmpl', 'commands/add.md']);
  if (withs.has('hook')) files.push(['extras/hook.js.tmpl', 'hooks/hint.js']);
  if (withs.has('ui')) {
    files.push(
      ['ui/view.json.tmpl', 'views/main.json'],
      ['ui/index.html.tmpl', 'ui/index.html'],
      ['ui/app.js.tmpl', 'ui/app.js'],
      ['ui/style.css.tmpl', 'ui/style.css'],
      ['ui/icon.svg.tmpl', 'ui/icon.svg'],
    );
  }
  const written = [];
  for (const [from, to] of files) {
    const target = join(root, ...to.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fill(await readFile(join(TEMPLATES, ...from.split('/')), 'utf8'), to.endsWith('.json')));
    written.push(to);
  }
  return { root, files: written };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const o = parse(process.argv.slice(2));
  if (o.help || !o.name) {
    console.log('用法：node scaffold.mjs <插件名> [--dir 上级文件夹] [--display "显示名"] [--description "..."] [--with skill,command,hook,ui] [--with-ui] [--placement sidebar|panel] [--force]');
    process.exit(o.help ? 0 : 2);
  }
  try {
    const r = await scaffold(o);
    console.log(`已生成 ${r.root}`);
    for (const f of r.files) console.log(`  ${f}`);
    console.log('\n下一步：改 server/tools.js 和 server/backend.js，跑 node --test，再用 check.mjs 校验打包。');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
