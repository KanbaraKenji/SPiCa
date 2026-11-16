// A plugin's words in other languages (manifest.json · i18n): read leniently, picked per language, and an old
// manifest without them is unchanged.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { localizeCommand, localizeDescription, localizeOffer, localizeView, offerTexts, parseI18n, pluginText } from './i18n.ts';
import { validateManifest } from './manifest.ts';
import { readPluginFolder } from './folder.ts';

const BASE = { manifest_version: 1, name: 'notes', version: '1.0.0', description: '在工作文件夹里记笔记', display_name: '笔记', author: 'A', license: 'MIT', compatibility: { spica: '*' } };

describe('manifest.json · i18n', () => {
  it('is read into the manifest; a manifest without it is as before', () => {
    const old = validateManifest(BASE);
    expect(old.manifest?.i18n).toBeUndefined();
    expect(old.issues).toEqual([]);
    const { manifest, issues } = validateManifest({
      ...BASE,
      i18n: {
        en: { display_name: 'Notes', description: 'Keeps notes', model_reason: 'Summarizes', mock_description: 'Sample notes', views: { notebook: 'Notebook' }, commands: { sum: { description: 'Summarize', argument_hint: '<note>' } }, skills: { tidy: 'Tidies notes' } },
        'zh-TW': { display_name: '筆記' },
      },
    });
    expect(issues).toEqual([]);
    expect(manifest?.i18n).toEqual({
      en: { displayName: 'Notes', description: 'Keeps notes', modelReason: 'Summarizes', mockDescription: 'Sample notes', views: { notebook: 'Notebook' }, commands: { sum: { description: 'Summarize', argumentHint: '<note>' } }, skills: { tidy: 'Tidies notes' } },
      'zh-TW': { displayName: '筆記' },
    });
  });

  it('never stops an install: what is not as described is a warning and left out', () => {
    const { manifest, issues } = validateManifest({ ...BASE, i18n: { fr: { description: 'x' }, en: { description: 3, views: { a: 1 }, colour: 'red', display_name: 'Notes' } } });
    expect(manifest).toBeDefined();
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(issues.map((i) => i.where)).toEqual(['manifest.json · i18n.fr', 'manifest.json · i18n.en.description', 'manifest.json · i18n.en.views', 'manifest.json · i18n.en.colour']);
    expect(manifest?.i18n).toEqual({ en: { displayName: 'Notes' } });
    const notObject = validateManifest({ ...BASE, i18n: 'en' });
    expect(notObject.manifest?.i18n).toBeUndefined();
    expect(notObject.issues.map((i) => i.severity)).toEqual(['warning']);
  });

  it('warns about a view, command or skill the plugin does not have', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spica-i18n-'));
    try {
      await mkdir(join(dir, 'views'));
      await writeFile(join(dir, 'views', 'notebook.json'), JSON.stringify({ title: '笔记本', entry: 'index.html' }));
      await writeFile(join(dir, 'index.html'), '<p></p>');
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...BASE, i18n: { en: { views: { notebook: 'Notebook', notbook: 'Typo' }, skills: { gone: 'x' } } } }));
      const f = await readPluginFolder(dir);
      expect(f.issues.map((i) => [i.where, i.severity])).toEqual([
        ['manifest.json · i18n.en.views.notbook', 'warning'],
        ['manifest.json · i18n.en.skills.gone', 'warning'],
      ]);
      expect(f.manifest).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parseI18n leaves nothing when nothing is usable', () => {
    const warned: string[] = [];
    expect(parseI18n({ en: {} }, (p) => warned.push(p))).toEqual({ en: {} });
    expect(parseI18n({ xx: {} }, (p) => warned.push(p))).toBeUndefined();
    expect(warned).toEqual(['i18n.xx']);
  });
});

describe('picking a language', () => {
  const i18n = { en: { displayName: 'Notes', views: { notebook: 'Notebook' }, commands: { sum: { description: 'Summarize' } } }, 'zh-CN': { description: '简体的描述' }, 'zh-TW': { displayName: '筆記' } };

  it('the copy for the language, Traditional falling back to Simplified, then what the plugin wrote', () => {
    expect(pluginText(i18n, 'en', (t) => t.displayName, '笔记')).toBe('Notes');
    expect(pluginText(i18n, 'en', (t) => t.description, '原文')).toBe('原文');
    expect(pluginText(i18n, 'zh-TW', (t) => t.description, '原文')).toBe('简体的描述');
    expect(pluginText(i18n, 'zh-TW', (t) => t.displayName, '笔记')).toBe('筆記');
    expect(pluginText(undefined, 'en', (t) => t.displayName, '笔记')).toBe('笔记');
  });

  it('a description, a page, a command and a card', () => {
    const d = localizeDescription(
      { displayName: '笔记', description: '原文', skills: [], commands: [{ id: 'sum', description: '总结', argumentHint: '<笔记>' }], views: [{ id: 'notebook', title: '笔记本' }], model: { reason: '写摘要' }, i18n },
      'en',
    );
    expect([d.displayName, d.description, d.commands[0], d.views[0]!.title, d.model?.reason]).toEqual(['Notes', '原文', { id: 'sum', description: 'Summarize', argumentHint: '<笔记>' }, 'Notebook', '写摘要']);
    expect(localizeView({ id: 'notebook', title: '笔记本', pluginTitle: '笔记', i18n }, 'zh-TW')).toMatchObject({ title: '笔记本', pluginTitle: '筆記' });
    expect(localizeCommand({ name: 'notes:sum', plugin: 'notes', description: '总结', i18n }, 'en').description).toBe('Summarize');
    expect(localizeOffer({ name: 'notes', displayName: '笔记', description: '原文', i18n }, 'en')).toMatchObject({ displayName: 'Notes', description: '原文' });
    const plain = { displayName: '笔记', description: '原文', skills: [], commands: [], views: [] };
    expect(localizeDescription(plain, 'en')).toBe(plain);
  });

  it('the settings form: each field’s title, description and placeholder; a key it does not have is a warning', async () => {
    const { manifest, issues } = validateManifest({
      ...BASE,
      user_config: { folder: { type: 'folder', title: 'Notes folder', description: 'Where notes go' }, url: { type: 'url', title: 'Catalog URL', placeholder: 'https://…' } },
      i18n: { 'zh-CN': { user_config: { folder: { title: '笔记文件夹' }, url: { title: '目录地址', placeholder: '网址' } } } },
    });
    expect(issues).toEqual([]);
    const d = localizeDescription(
      { displayName: 'Notes', description: '', skills: [], commands: [], views: [], config: { fields: [{ key: 'folder', title: 'Notes folder', description: 'Where notes go' }, { key: 'url', title: 'Catalog URL', placeholder: 'https://…' }] }, i18n: manifest!.i18n! },
      'zh-TW',
    );
    expect(d.config?.fields).toEqual([
      { key: 'folder', title: '笔记文件夹', description: 'Where notes go' },
      { key: 'url', title: '目录地址', placeholder: '网址' },
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'spica-i18n-'));
    try {
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...BASE, user_config: { folder: { type: 'folder', title: 'Notes folder' } }, i18n: { en: { user_config: { fodler: { title: 'Typo' } } } } }));
      const f = await readPluginFolder(dir);
      expect(f.issues.map((i) => [i.where, i.severity])).toEqual([['manifest.json · i18n.en.user_config.fodler', 'warning']]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a card read from someone else’s index keeps only text', () => {
    expect(offerTexts({ en: { displayName: 'Notes', description: 4, views: { a: 'b' } }, fr: { displayName: 'x' }, 'zh-TW': 'bad' })).toEqual({ en: { displayName: 'Notes' } });
    expect(offerTexts('x')).toBeUndefined();
  });
});

describe('the official plugins', () => {
  const root = fileURLToPath(new URL('../../../plugins/', import.meta.url));
  it.each(['example-notes', 'office-preview', 'outlook-mail'])('%s has its words in all three languages, English without Chinese', async (dir) => {
    const f = await readPluginFolder(join(root, dir));
    expect(f.issues.filter((i) => i.where.includes('i18n'))).toEqual([]);
    const m = f.manifest!;
    const d = {
      displayName: m.displayName,
      description: m.description,
      skills: f.skills.map((x) => ({ id: x.id, description: x.description })),
      commands: f.commands.map((x) => ({ id: x.id, description: x.description, ...(x.argumentHint ? { argumentHint: x.argumentHint } : {}) })),
      views: f.views.map((x) => ({ id: x.id, title: x.title })),
      ...(m.permissions.model ? { model: m.permissions.model } : {}),
      ...(m.i18n ? { i18n: m.i18n } : {}),
    };
    const words = (x: typeof d) => [x.displayName, x.description, ...x.skills.map((s) => s.description), ...x.commands.flatMap((c) => [c.description, c.argumentHint ?? '']), ...x.views.map((v) => v.title), x.model?.reason ?? ''].filter(Boolean);
    expect(words(localizeDescription(d, 'en')).filter((w) => /[\u3400-\u9fff]/.test(w))).toEqual([]);
    for (const zh of ['zh-CN', 'zh-TW'] as const) expect(words(localizeDescription(d, zh)).filter((w) => !/[\u3400-\u9fff]/.test(w) && /[a-z]{4} [a-z]{4}/.test(w))).toEqual([]);
  });
});
