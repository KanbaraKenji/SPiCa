// Inject one line after the system prompt so the model knows the notebook exists.
// A hook module default-exports a hooks object, or a factory that receives the plugin context.

/** @type {import('@spica/plugins/types').HookModule} */
export default (ctx) => ({
  inject() {
    const mode = ctx.mock() ? ' (mock mode: the catalog returns sample data)' : '';
    // Read at each call: the user can change the account in Spica's settings while the plugin is on.
    const who = ctx.user.account ? ` Notes are signed ${ctx.user.account}.` : '';
    return [
      {
        position: 'system:after',
        text: `The Notes plugin is active${mode}. Save decisions and facts the user wants to keep with notes__write_note.${who}`,
      },
    ];
  },
});
