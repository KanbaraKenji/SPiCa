// What `scaffold.mjs --with config` adds to the generated files: a settings form
// of three fields (an address, a password, a choice) in the manifest, a tool
// that reads them, and a test. Without --with config every part is empty.

export const USER_CONFIG = `,
  "user_config": {
    "server_url": { "type": "url", "title": "服务器地址", "placeholder": "https://items.example.com", "required": true },
    "password": { "type": "password", "title": "密码", "required": true },
    "mode": { "type": "select", "title": "汇总方式", "options": ["日报", "周报"], "default": "日报" }
  }`;

export const CONFIG_IMPORT = `
import { readConfig } from './config.js';`;

export const CONFIG_TOOL = `
  {
    // Reads the settings the user filled in (server/config.js); never returns the password.
    name: 'check_settings',
    description: 'Show which server this plugin talks to and how it sums up (never the password). Use it when the user asks how the plugin is set up or why it cannot connect.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },`;

export const CONFIG_CASE = `    case 'check_settings': {
      const { server_url, password, mode } = readConfig();
      if (!server_url || !password) throw new PluginToolError('NOT_CONFIGURED', '还没填服务器地址或密码：设置 › 插件 › 这个插件。');
      return { server_url, mode, password_set: true };
    }
`;

export const CONFIG_TEST = `
test('the settings the user filled in reach the tool (mock/user-config.json here); the password never comes back', async () => {
  const r = await call('check_settings');
  assert.ok(!r.isError);
  const v = JSON.parse(text(r));
  assert.equal(v.server_url, 'https://items.example.com');
  assert.equal(v.password_set, true);
  assert.doesNotMatch(text(r), /mock-pass1/);
});
`;

export const TOOL_NAMES = (config) => JSON.stringify(['add_item', ...(config ? ['check_settings'] : []), 'get_item', 'list_items', 'remove_item']).replaceAll(',', ', ').replaceAll('"', "'");
