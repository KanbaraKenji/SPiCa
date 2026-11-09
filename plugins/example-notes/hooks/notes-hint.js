// Inject one line after the system prompt so the model knows the notebook exists.
// A hook module default-exports a hooks object, or a factory that receives the plugin context.

/** @type {import('@spica/plugins/types').HookModule} */
export default (ctx) => ({
  inject() {
    const mode = ctx.mock() ? ' (mock mode: the catalog returns sample data)' : '';
    return [
      {
        position: 'system:after',
        text: `The Notes plugin is active${mode}. Save decisions and facts the user wants to keep with notes__write_note.`,
      },
    ];
  },
});
