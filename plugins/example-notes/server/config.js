// The settings the user filled in for Notes (manifest.json · user_config): the
// notes folder and the catalog address. Spica draws the form under
// 设置 › 插件 › Notes › 详情 and hands the values to the servers in
// SPICA_USER_CONFIG, one JSON object with every declared key (null when not
// filled in). Outside Spica there is no such variable: everything is null.
//
// Before user_config, the plugin's own settings page saved the same two things
// into <SPICA_PLUGIN_DATA>/config.json (notesFolder, catalogUrl). Until the user
// saves the form, those older values still count, so nobody loses their folder.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached;

/** { notes_folder, catalog_url }: the form's values, else the older config.json's, else null. Read once. */
export function readConfig() {
  if (cached) return cached;
  let form = {};
  if (process.env.SPICA_USER_CONFIG) {
    form = JSON.parse(process.env.SPICA_USER_CONFIG);
    // out of the environment: processes this server starts do not inherit it
    delete process.env.SPICA_USER_CONFIG;
  }
  let older = {};
  try {
    older = JSON.parse(readFileSync(join(process.env.SPICA_PLUGIN_DATA || join(process.cwd(), '.data'), 'config.json'), 'utf8'));
  } catch {
    // none: the plugin was set up after user_config came in
  }
  cached = {
    notes_folder: form.notes_folder ?? older.notesFolder ?? null,
    catalog_url: form.catalog_url ?? older.catalogUrl ?? null,
  };
  return cached;
}
