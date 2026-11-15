import { describe, expect, it } from 'vitest';
import { buildSources, channelFile, OFFICIAL_APP_ID, OFFICIAL_CHANNEL, OFFICIAL_PLUGINS_LABEL } from './channel';

const spica = { appId: OFFICIAL_APP_ID, packaged: true };
const nova = { appId: 'com.example.nova', packaged: true };
const officialIndex = `${OFFICIAL_CHANNEL}index.json`;

describe('buildSources', () => {
  it('Spica as published, nothing in deploy.json: the official channel for both', () => {
    for (const deploy of [undefined, {}, { app: { name: '' } }, { updateSource: null, pluginSources: null }]) {
      expect(buildSources({ ...spica, deploy })).toEqual({ updateSource: OFFICIAL_CHANNEL, pluginSources: [{ location: officialIndex, label: OFFICIAL_PLUGINS_LABEL }] });
    }
  });

  it('"" and [] turn each off on its own', () => {
    expect(buildSources({ ...spica, deploy: { updateSource: '' } })).toEqual({ updateSource: '', pluginSources: [{ location: officialIndex, label: OFFICIAL_PLUGINS_LABEL }] });
    expect(buildSources({ ...spica, deploy: { pluginSources: [] } })).toEqual({ updateSource: OFFICIAL_CHANNEL, pluginSources: [] });
  });

  it('written ones replace the official channel', () => {
    expect(buildSources({ ...spica, deploy: { updateSource: ' \\\\server\\spica ', pluginSources: ['https://plugins.example.com/index.json'] } })).toEqual({
      updateSource: '\\\\server\\spica',
      pluginSources: [{ location: 'https://plugins.example.com/index.json' }],
    });
  });

  it('a build with its own app id never takes updates from the official channel, but lists its plugins unless told otherwise', () => {
    const official = [{ location: officialIndex, label: OFFICIAL_PLUGINS_LABEL }];
    expect(buildSources({ ...nova, deploy: undefined })).toEqual({ updateSource: '', pluginSources: official });
    expect(buildSources({ ...nova, deploy: { app: { name: 'Nova Desk', id: 'com.example.nova' } } })).toEqual({ updateSource: '', pluginSources: official });
    expect(buildSources({ ...nova, deploy: { updateSource: 'https://updates.example.com/nova/' } }).updateSource).toBe('https://updates.example.com/nova/');
    expect(buildSources({ ...nova, deploy: { pluginSources: [] } }).pluginSources).toEqual([]);
    expect(buildSources({ ...nova, deploy: { pluginSources: ['https://plugins.example.com/index.json'] } }).pluginSources).toEqual([{ location: 'https://plugins.example.com/index.json' }]);
  });

  it('a development run: no update checks, the repository plugins folder, unless deploy.json says otherwise', () => {
    const dev = { appId: OFFICIAL_APP_ID, packaged: false, repoPlugins: 'K:\\repo\\plugins' };
    const r = buildSources({ ...dev, deploy: undefined });
    expect(r.updateSource).toBe('');
    expect(r.pluginSources).toEqual([{ location: 'K:\\repo\\plugins', label: '官方插件（开发版：仓库的 plugins 文件夹）', exclude: ['example-eval'] }]);
    expect(buildSources({ ...dev, deploy: { updateSource: 'http://127.0.0.1:8765/', pluginSources: [] } })).toEqual({ updateSource: 'http://127.0.0.1:8765/', pluginSources: [] });
    expect(buildSources({ ...dev, repoPlugins: undefined, deploy: undefined }).pluginSources).toEqual([]);
  });

  it('a channel that moved is used for both', () => {
    const channel = 'https://spica.example.com/channel/';
    expect(buildSources({ ...spica, deploy: undefined, channel })).toEqual({ updateSource: channel, pluginSources: [{ location: `${channel}index.json`, label: OFFICIAL_PLUGINS_LABEL }] });
  });
});

describe('channelFile', () => {
  it('joins with or without the slash', () => {
    expect(channelFile('https://a.example/x/', 'index.json')).toBe('https://a.example/x/index.json');
    expect(channelFile('https://a.example/x', 'index.json')).toBe('https://a.example/x/index.json');
  });
});
