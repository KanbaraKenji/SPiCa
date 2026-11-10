// The app's name and id. Spica unless a company's deploy.json renames it when
// packaging (scripts/deploy.mjs); electron.vite.config.ts bakes them in as
// __SPICA_APP__. Tests and tools that do not go through it get Spica.
declare const __SPICA_APP__: { name: string; id: string } | undefined;

export const APP_IDENTITY: { name: string; id: string } = typeof __SPICA_APP__ === 'undefined' ? { name: 'Spica', id: 'dev.spica.desktop' } : __SPICA_APP__;

/** What people see: window title, settings, prompts in the UI, folder names. */
export const APP_NAME = APP_IDENTITY.name;
