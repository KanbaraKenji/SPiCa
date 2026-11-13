import { describe, expect, it } from 'vitest';
import { editMenu, type EditMenuParams } from './edit-menu';

const flags = (on: Partial<EditMenuParams['editFlags']> = {}): EditMenuParams['editFlags'] => ({
  canUndo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  ...on,
});

const shown = (p: EditMenuParams) => editMenu(p)?.map((e) => (e === 'separator' ? '—' : e.label + (e.enabled ? '' : '（灰）')));

describe('the right-click menu in a text box (Windows’ own)', () => {
  it('a Windows text box’s items, in its order, with its access keys', () => {
    expect(shown({ isEditable: true, editFlags: flags({ canUndo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true }) })).toEqual([
      '撤消(&U)',
      '—',
      '剪切(&T)',
      '复制(&C)',
      '粘贴(&P)',
      '删除(&D)',
      '—',
      '全选(&A)',
    ]);
  });

  it('what cannot be done is greyed, as the page says (nothing selected, an empty box)', () => {
    expect(shown({ isEditable: true, editFlags: flags({ canPaste: true }) })).toEqual(['撤消(&U)（灰）', '—', '剪切(&T)（灰）', '复制(&C)（灰）', '粘贴(&P)', '删除(&D)（灰）', '—', '全选(&A)（灰）']);
  });

  it('nothing outside a text box (selected words there have the app’s own 复制)', () => {
    expect(editMenu({ isEditable: false, editFlags: flags({ canCopy: true }) })).toBeNull();
  });
});
