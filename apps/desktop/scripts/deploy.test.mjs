import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP, OFFICIAL_CHANNEL, readDeploy } from './deploy.mjs';
import { builderOverrides, sourceLines } from './dist.mjs';
import { OFFICIAL_APP_ID, OFFICIAL_CHANNEL as APP_CHANNEL } from '../src/main/update/channel';

const dirWith = (json, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'spica-deploy-'));
  if (json !== undefined) writeFileSync(join(dir, 'deploy.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

describe('deploy.json', () => {
  it('none, or no "app": Spica as published, no packaging overrides', () => {
    expect(readDeploy(dirWith(undefined)).app).toMatchObject(DEFAULT_APP);
    const d = readDeploy(dirWith({ updateSource: '\\\\server\\share' }));
    expect(d.app).toMatchObject(DEFAULT_APP);
    expect(d.updateSource).toBe('\\\\server\\share');
    expect(builderOverrides(d.app, '1.0.0')).toEqual([]);
  });

  it('deploy.example.json copied as is changes nothing; its example, filled in, renames', () => {
    const example = readFileSync(new URL('../deploy.example.json', import.meta.url), 'utf8');
    const d = readDeploy(dirWith(example));
    expect(d.app).toMatchObject({ ...DEFAULT_APP, icon: null, font: null, copyright: null });
    expect(d.updateSource).toBeNull();
    expect(d.pluginSources).toBeNull();
    expect(builderOverrides(d.app, '1.0.0')).toEqual([]);
    const filled = JSON.parse(example);
    filled.app = { ...filled.app, name: 'Nova Desk', id: 'com.example.nova' };
    expect(readDeploy(dirWith(filled)).app).toMatchObject({ name: 'Nova Desk', id: 'com.example.nova', icon: null, font: null });
  });

  it('a name and id rename the installer, shortcut and app id', () => {
    const d = readDeploy(dirWith({ app: { name: 'Nova Desk', id: 'com.example.nova' } }, { 'n.ico': 'x' }));
    expect(d.app).toMatchObject({ name: 'Nova Desk', id: 'com.example.nova', icon: null, font: null });
    expect(builderOverrides(d.app, '1.2.0')).toEqual([
      '-c.appId=com.example.nova',
      '-c.productName=Nova Desk',
      '-c.nsis.shortcutName=Nova Desk',
      '-c.nsis.artifactName=Nova Desk-Setup-1.2.0.${ext}',
      '-c.portable.artifactName=Nova Desk-Portable-1.2.0.${ext}',
      '-c.extraMetadata.description=Nova Desk',
    ]);
    expect(d.app.copyright).toBeNull();
  });

  it('a copyright line of its own goes into the exe; not written, Spica’s stays; it must be one line', () => {
    const d = readDeploy(dirWith({ app: { name: 'Nova Desk', id: 'com.example.nova', copyright: ' Copyright Example Corp ' } }));
    expect(d.app.copyright).toBe('Copyright Example Corp');
    expect(builderOverrides(d.app, '1.0.0')).toContain('-c.copyright=Copyright Example Corp');
    expect(() => readDeploy(dirWith({ app: { name: 'Nova Desk', id: 'com.example.nova', copyright: 'a\nb' } }))).toThrow('app.copyright');
    expect(() => readDeploy(dirWith({ app: { copyright: 3 } }))).toThrow('app.copyright');
  });

  it('an icon and a font are found next to deploy.json', () => {
    const dir = dirWith({ app: { name: 'Nova', id: 'com.example.nova', icon: 'nova.ico', font: 'nova.ttf' } }, { 'nova.ico': 'x', 'nova.ttf': 'x' });
    const d = readDeploy(dir);
    expect(d.app.icon).toBe(join(dir, 'nova.ico'));
    expect(d.app.font).toBe(join(dir, 'nova.ttf'));
    expect(builderOverrides(d.app, '1.0.0')).toContain(`-c.win.icon=${join(dir, 'nova.ico')}`);
  });

  it('stops packaging with a plain message when something is wrong', () => {
    expect(() => readDeploy(dirWith('{ not json'))).toThrow('deploy.json 读不了');
    expect(() => readDeploy(dirWith({ app: { name: 'Nova' } }))).toThrow('也要写 app.id');
    expect(() => readDeploy(dirWith({ app: { name: 'Nova', id: 'dev.spica.desktop' } }))).toThrow('app.id 也要换一个');
    expect(() => readDeploy(dirWith({ app: { name: 'A/B', id: 'com.example.ab' } }))).toThrow('不能用');
    expect(() => readDeploy(dirWith({ app: { name: 'Nova', id: 'nova' } }))).toThrow('com.example.app');
    expect(() => readDeploy(dirWith({ app: { name: 'Nova', id: 'com.example.nova', icon: 'missing.ico' } }))).toThrow('不存在');
    expect(() => readDeploy(dirWith({ app: { name: 'Nova', id: 'com.example.nova', icon: 'n.png' } }, { 'n.png': 'x' }))).toThrow('.ico');
  });

  it('company presets (models): the example in the note is good; mistakes and keys stop packaging, in plain words', () => {
    const note = JSON.parse(readFileSync(new URL('../deploy.example.json', import.meta.url), 'utf8'))['// models'];
    const example = JSON.parse(note.slice(note.indexOf('Example: ') + 'Example: '.length));
    expect(readDeploy(dirWith({ models: [example] })).models).toEqual([example]);
    const bad = { models: [{ ...example, apiKey: 'sk-x' }, { id: 'gw', name: '网关', kind: 'wso2', baseUrl: 'https://gw.example.com/v1', models: [{ id: 'm', contextWindow: 0 }] }] };
    let message = '';
    try {
      readDeploy(dirWith(bad));
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain('deploy.json 的 models 有 3 处要改');
    expect(message).toContain('第 1 个连接（acme-gateway）：不能写 apiKey');
    expect(message).toContain('第 2 个连接（gw）：wso2 要写 tokenUrl');
    expect(message).toContain('第 2 个连接（gw）的第 1 个型号（m）：contextWindow 要写正整数');
  });

  it('a preset may name its key header and WSO2 credentials place; a header value stops the packaging', () => {
    const example = JSON.parse(readFileSync(new URL('../deploy.example.json', import.meta.url), 'utf8'))['// models'].replace(/^.*Example: /, '');
    const preset = { ...JSON.parse(example), headers: ['X-API-Key'] };
    expect(readDeploy(dirWith({ models: [preset] })).models[0].headers).toEqual(['X-API-Key']);
    const messageOf = (models) => {
      try {
        readDeploy(dirWith({ models }));
        return '';
      } catch (e) {
        return e.message;
      }
    };
    expect(messageOf([{ ...preset, headers: { 'X-API-Key': 'k' } }])).toContain('第 1 个连接（acme-gateway）：headers 要写成请求头名称的列表');
    expect(messageOf([{ ...preset, headers: ['Host'] }])).toContain('headers 里不能写 Host，它由应用设置');
    expect(messageOf([{ ...preset, credentialsIn: 'body' }])).toContain('credentialsIn 只给 wso2 写，只能是 basic 或 body');
  });

  it('pluginSources: absent is null (the official channel), [] is none; a place or { location, label }; a wrong one stops the packaging', () => {
    expect(readDeploy(dirWith({})).pluginSources).toBeNull();
    expect(readDeploy(dirWith(undefined)).pluginSources).toBeNull();
    expect(readDeploy(dirWith({ pluginSources: [] })).pluginSources).toEqual([]);
    expect(readDeploy(dirWith({ pluginSources: ['https://plugins.example.com/index.json', { location: ' \\\\server\\plugins ', label: ' 团队插件 ' }] })).pluginSources).toEqual([
      { location: 'https://plugins.example.com/index.json' },
      { location: '\\\\server\\plugins', label: '团队插件' },
    ]);
    expect(() => readDeploy(dirWith({ pluginSources: 'https://plugins.example.com/index.json' }))).toThrow(/要写成一个列表/);
    expect(() => readDeploy(dirWith({ pluginSources: ['plugins'] }))).toThrow(/第 1 项「plugins」不能用/);
    expect(() => readDeploy(dirWith({ pluginSources: [{ label: 'x' }] }))).toThrow(/第 1 项要写地址/);
    expect(() => readDeploy(dirWith({ pluginSources: ['https://plugins.example.com/a-1.0.0.zip'] }))).toThrow(/单个插件包/);
  });

  it('updateSource: absent is null (the official channel), "" is no checks, a place as before; a wrong one stops the packaging', () => {
    expect(readDeploy(dirWith({})).updateSource).toBeNull();
    expect(readDeploy(dirWith(undefined)).updateSource).toBeNull();
    expect(readDeploy(dirWith({ updateSource: '' })).updateSource).toBe('');
    expect(readDeploy(dirWith({ updateSource: ' https://updates.example.com/nova/ ' })).updateSource).toBe('https://updates.example.com/nova/');
    expect(() => readDeploy(dirWith({ updateSource: 'updates' }))).toThrow(/updateSource「updates」不能用/);
    expect(() => readDeploy(dirWith({ updateSource: 3 }))).toThrow(/要写成地址/);
  });

  it('a renamed build cannot take updates from the official channel', () => {
    const nova = { name: 'Nova Desk', id: 'com.example.nova' };
    expect(() => readDeploy(dirWith({ app: nova, updateSource: OFFICIAL_CHANNEL }))).toThrow(/不能是 Spica 的官方地址/);
    expect(() => readDeploy(dirWith({ app: nova, updateSource: OFFICIAL_CHANNEL.replace(/\/$/, '').toUpperCase() }))).toThrow(/官方地址/);
    expect(readDeploy(dirWith({ app: nova, pluginSources: [`${OFFICIAL_CHANNEL}index.json`] })).pluginSources).toEqual([{ location: `${OFFICIAL_CHANNEL}index.json` }]);
  });

  it('the packaging says where the app will look; the address is the one the app uses', () => {
    expect(OFFICIAL_CHANNEL).toBe(APP_CHANNEL);
    expect(DEFAULT_APP.id).toBe(OFFICIAL_APP_ID);
    expect(sourceLines(readDeploy(dirWith(undefined)))).toEqual([`updates: official channel ${OFFICIAL_CHANNEL}`, `official plugins: official channel ${OFFICIAL_CHANNEL}index.json`]);
    expect(sourceLines(readDeploy(dirWith({ updateSource: '', pluginSources: [] })))).toEqual(['updates: none', 'official plugins: none']);
    expect(sourceLines(readDeploy(dirWith({ app: { name: 'Nova Desk', id: 'com.example.nova' } })))).toEqual(['updates: none (not in deploy.json)', `official plugins: official channel ${OFFICIAL_CHANNEL}index.json`]);
  });
});
