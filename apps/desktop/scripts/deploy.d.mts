export interface DeployApp {
  name: string;
  id: string;
  icon: string | null;
  font: string | null;
}
export const DEFAULT_APP: Readonly<{ name: string; id: string }>;
export const OFFICIAL_CHANNEL: string;
export interface DeployPluginSource {
  location: string;
  label?: string;
}
export function readDeploy(dir?: string): { file: string | null; updateSource: string | null; pluginSources: DeployPluginSource[] | null; app: DeployApp; models: unknown[] };
export function presetProblemText(line: string): string;
