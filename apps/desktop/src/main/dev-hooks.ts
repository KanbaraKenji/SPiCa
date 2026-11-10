// Development-only answers for the system pickers, so test scripts never drive a
// Windows dialog: SPICA_PICK_FOLDER=<dir> and SPICA_PICK_FILES=<a;b>. Never in an
// installed build, whatever the environment says.

/** The folder the picker answers without showing; null: show the dialog. */
export function pickedFolder(env: NodeJS.ProcessEnv, packaged: boolean): string | null {
  if (packaged) return null;
  return env.SPICA_PICK_FOLDER || null;
}

/** The files the picker answers without showing (;-separated, at most 20); null: show the dialog. */
export function pickedFiles(env: NodeJS.ProcessEnv, packaged: boolean): string[] | null {
  if (packaged || !env.SPICA_PICK_FILES) return null;
  return env.SPICA_PICK_FILES.split(';').filter(Boolean).slice(0, 20);
}
