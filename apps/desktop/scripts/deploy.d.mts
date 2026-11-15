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
  /** All its addresses in the order to try, when deploy.json gives more than one (location is the first). */
  mirrors?: string[];
  label?: string;
}
export function readDeploy(dir?: string): { file: string | null; updateSource: string | null; updateSources: string[] | null; pluginSources: DeployPluginSource[] | null; app: DeployApp; models: unknown[] };
export function presetProblemText(line: string): string;
