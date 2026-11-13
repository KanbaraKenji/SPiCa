// Right click in a text box (the input box, a field in 设置, a number box …): Windows' own menu, drawn by the system
// (Menu.popup), with the items and names of a Windows text box: 撤消 / 剪切 / 复制 / 粘贴 / 删除 / 全选. What can be
// done is the page's own answer (the context-menu event's editFlags). Words selected elsewhere in the page keep the
// app's 复制 menu (renderer ui/TextMenu.tsx), which takes the event before it gets here.

export type EditAction = 'undo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll';

export interface EditMenuItem {
  /** Windows' own label, with its access key (& before the letter, shown underlined only when opened from the keyboard). */
  label: string;
  action: EditAction;
  enabled: boolean;
}

export type EditMenuEntry = EditMenuItem | 'separator';

/** The part of Electron's context-menu params this needs. */
export interface EditMenuParams {
  isEditable: boolean;
  editFlags: { canUndo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canDelete: boolean; canSelectAll: boolean };
}

/** The menu for a right click, or null when it was not in a text box (nothing is shown then). */
export function editMenu(params: EditMenuParams): EditMenuEntry[] | null {
  if (!params.isEditable) return null;
  const f = params.editFlags;
  return [
    { label: '撤消(&U)', action: 'undo', enabled: f.canUndo },
    'separator',
    { label: '剪切(&T)', action: 'cut', enabled: f.canCut },
    { label: '复制(&C)', action: 'copy', enabled: f.canCopy },
    { label: '粘贴(&P)', action: 'paste', enabled: f.canPaste },
    { label: '删除(&D)', action: 'delete', enabled: f.canDelete },
    'separator',
    { label: '全选(&A)', action: 'selectAll', enabled: f.canSelectAll },
  ];
}
