import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP, readDeploy } from './deploy.mjs';
import { builderOverrides } from './dist.mjs';

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

  it('a name and id rename the installer, shortcut and app id', () => {
    const d = readDeploy(dirWith({ app: { name: 'Nova Desk', id: 'com.example.nova' } }, { 'n.ico': 'x' }));
    expect(d.app).toMatchObject({ name: 'Nova Desk', id: 'com.example.nova', icon: null, font: null });
    expect(builderOverrides(d.app, '1.2.0')).toEqual([
      '-c.appId=com.example.nova',
      '-c.productName=Nova Desk',
      '-c.nsis.shortcutName=Nova Desk',
      '-c.nsis.artifactName=Nova Desk-Setup-1.2.0.${ext}',
      '-c.portable.artifactName=Nova Desk-Portable-1.2.0.${ext}',
    ]);
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
});
