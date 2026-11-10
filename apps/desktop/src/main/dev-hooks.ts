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

/**
 * Where 文档 is for a development run on another settings folder (SPICA_USER_DATA, or the screenshots' own):
 * a Documents folder inside it, so the default workflow folder, the export's default place and the folder
 * conversations shared up to 0.1.0-rc.2 never point into the developer's own 文档. null: the system's.
 * An installed build keeps the system's even with SPICA_USER_DATA (a test install upgraded over rc.2 data
 * must still see that shared folder).
 */
export function documentsFolder(env: NodeJS.ProcessEnv, packaged: boolean, automated: boolean, userData: string): string | null {
  if (packaged || !(env.SPICA_USER_DATA || automated)) return null;
  const sep = userData.includes('\\') ? '\\' : '/';
  return `${userData.replace(/[\\/]+$/, '')}${sep}Documents`;
}

/**
 * Whether to make the default workflow folder (文档\<name>\workflows) when the app starts. An installed build
 * makes it so it is there to find and edit, unless another folder is set in 设置 › 常规; a development run
 * never does (it is made when 打开文件夹 is clicked).
 */
export function makeWorkflowsDirAtStart(packaged: boolean, chosenDir: string): boolean {
  return packaged && !chosenDir;
}
