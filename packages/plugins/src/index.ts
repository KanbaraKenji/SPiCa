// Spica plugin system: public entry point.
export {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  DEFAULT_MODEL_USD_PER_DAY,
  DEFAULT_APP_NAME,
  HOOK_KINDS,
  NAME_PATTERN,
  parseManifest,
  validateManifest,
  compareVersions,
  satisfies,
  isSemver,
  type HookKind,
  type Issue,
  type PluginManifest,
  type PluginPermissions,
  type MailDeclaration,
  type MessageOptions,
} from './manifest.ts';
export {
  readPluginFolder,
  parseFrontmatter,
  expandCommand,
  insidePlugin,
  hasErrors,
  type PluginFolder,
  type SkillDef,
  type CommandDef,
  type ServerDef,
  type HookModuleDef,
  type ViewDef,
  VIEW_PLACEMENTS,
  ICON_MAX_BYTES,
} from './folder.ts';
export { runtimeHost, type PluginHost, type McpLaunch, type McpExit, type McpHandle, type RuntimeLike, type MailSourceSpec, type PluginToolCallResult } from './host.ts';
export {
  PluginManager,
  PluginError,
  SPICA_VERSION,
  PLUGIN_INHERIT_ENV,
  type PluginManagerOptions,
  type PluginDescription,
  type InstallStep,
  type InstallOptions,
  type PluginEvent,
  type PluginView,
  type PluginModelUse,
  type ViewCallResult,
  type PluginSource,
  type InstalledRecord,
  type ServerStatus,
} from './manager.ts';
export { packPlugin, unpackPlugin, verifyPackage, sha256 } from './pack.ts';
export {
  INDEX_FILE,
  listSource,
  newest,
  checkUpdates,
  installAvailable,
  installZip,
  writeIndex,
  type SourceConfig,
  type SourceOptions,
  type IndexEntry,
  type IndexFile,
  type Available,
  type UpdateInfo,
  type FetchLike,
} from './sources.ts';
export { readZip, writeZip, safeEntryName, ZipError, type ZipEntry } from './zip.ts';
export type { PluginContext, HookModule } from './authoring.ts';
export { attachBackend, pluginMcpTools, pluginMethods, type McpServiceTool, type PluginBackendOptions } from './backend.ts';
