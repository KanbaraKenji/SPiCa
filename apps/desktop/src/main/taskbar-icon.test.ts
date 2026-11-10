import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { iconFileName, pointShortcutsAt, shortcutFolders, type Shortcut, type ShortcutIo } from './taskbar-icon';

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Spica\\Spica.exe';
const ICO = 'C:\\Users\\me\\AppData\\Roaming\\Spica\\icons\\taskbar-abc.ico';

function fakeIo(files: Record<string, Record<string, Shortcut>>) {
  const set: string[] = [];
  const where = new Map<string, Shortcut>();
  for (const [dir, items] of Object.entries(files)) for (const [name, s] of Object.entries(items)) where.set(join(dir, name), s);
  const io: ShortcutIo = {
    list: (dir) => Object.keys(files[dir] ?? {}).map((f) => join(dir, f)),
    read: (path) => where.get(path) ?? null,
    setIcon: (path) => {
      set.push(path);
      return true;
    },
  };
  return { io, set };
}

describe('taskbar icon', () => {
  const [start, pinned] = shortcutFolders('C:\\Users\\me\\AppData\\Roaming') as [string, string];

  it('looks in the Start menu and the pinned taskbar items, not on the desktop', () => {
    expect(start.replace(/\\/g, '/')).toMatch(/Start Menu\/Programs$/);
    expect(pinned.replace(/\\/g, '/')).toMatch(/User Pinned\/TaskBar$/);
  });

  it('points only shortcuts that start this exe at the icon, and only when they show another one', () => {
    const { io, set } = fakeIo({
      [start]: {
        'Spica.lnk': { target: EXE.toLowerCase(), icon: `${EXE},0`, iconIndex: 0 },
        'Other.lnk': { target: 'C:\\Other\\Other.exe' },
      },
      [pinned]: { 'Spica.lnk': { target: EXE, icon: ICO, iconIndex: 0 } },
    });
    expect(pointShortcutsAt(io, [start, pinned], EXE, ICO)).toBe(1);
    expect(set).toEqual([join(start, 'Spica.lnk')]);
  });

  it('names the file after its content: another colour is another path', () => {
    const a = iconFileName(new Uint8Array([1, 2, 3]));
    expect(a).toMatch(/^taskbar-[0-9a-f]{12}\.ico$/);
    expect(iconFileName(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(iconFileName(new Uint8Array([1, 2, 4]))).not.toBe(a);
  });
});
