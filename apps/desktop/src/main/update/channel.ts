// Where an installed Spica looks for app updates and the official plugins when
// the packaging's deploy.json says nothing: the official channel, one fixed
// address that every release refreshes (see docs/design/desktop-shell.md
// section 9). A build packaged under another app id never uses it.
import { NOT_SHIPPED_PLUGINS, officialSources, type OfficialSource } from '../../shared/plugins';

/** The official channel: latest.yml, index.json (official plugins), channel.json. */
export const OFFICIAL_CHANNEL = 'https://github.com/KanbaraKenji/SPiCa/releases/download/channel/';
/** The app id Spica is published under; only that build uses the official channel. */
export const OFFICIAL_APP_ID = 'dev.spica.desktop';
export const OFFICIAL_PLUGINS_LABEL = '官方插件';

export interface BuildSources {
  /** Update and announcement source; '' when this build does not check. */
  updateSource: string;
  /** The official plugin sources (设置 › 插件 › 市场, listed first). */
  pluginSources: OfficialSource[];
}

export interface BuildSourcesInput {
  /** deploy.json as parsed, or undefined when there is none (or it cannot be read). */
  deploy: unknown;
  appId: string;
  packaged: boolean;
  /** The repository's plugins/ folder in a development run, when it exists. */
  repoPlugins?: string;
  /** The channel address; a test or a channel that moved passes its own. */
  channel?: string;
}

/**
 * What this build checks for updates and lists as official plugins.
 *
 * deploy.json keys, each on its own:
 *   absent                    the official channel (Spica as published only; a renamed build: none)
 *   "updateSource": ""        no update checks
 *   "pluginSources": []       no official plugin source
 *   any other value           that, as before
 * A development run never checks for updates unless deploy.json names a source, and lists the
 * repository's plugins/ folder unless deploy.json names plugin sources.
 */
export function buildSources(input: BuildSourcesInput): BuildSources {
  const raw = input.deploy && typeof input.deploy === 'object' ? (input.deploy as Record<string, unknown>) : {};
  const channel = input.channel ?? OFFICIAL_CHANNEL;
  const official = input.appId === OFFICIAL_APP_ID;

  let updateSource: string;
  if (raw.updateSource !== undefined && raw.updateSource !== null) updateSource = typeof raw.updateSource === 'string' ? raw.updateSource.trim() : '';
  else updateSource = official && input.packaged ? channel : '';

  let pluginSources: OfficialSource[];
  if (raw.pluginSources !== undefined && raw.pluginSources !== null) pluginSources = officialSources(raw.pluginSources);
  else if (!input.packaged) pluginSources = input.repoPlugins ? [{ location: input.repoPlugins, label: '官方插件（开发版：仓库的 plugins 文件夹）', exclude: NOT_SHIPPED_PLUGINS }] : [];
  else pluginSources = official ? [{ location: channelFile(channel, 'index.json'), label: OFFICIAL_PLUGINS_LABEL }] : [];

  return { updateSource, pluginSources };
}

/** A file in the channel folder. */
export function channelFile(channel: string, name: string): string {
  return new URL(name, channel.endsWith('/') ? channel : `${channel}/`).toString();
}
