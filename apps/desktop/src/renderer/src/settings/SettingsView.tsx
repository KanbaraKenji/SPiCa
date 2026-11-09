// Settings page, shown in the main pane.
import type { ShellStore } from '../store/shell';
import { useShell } from '../store/shell';
import { Appearance } from './Appearance';

export function SettingsView({ shell }: { shell: ShellStore }) {
  const { settings } = useShell(shell);
  return (
    <div className="settings">
      <div className="settings-column">
        <Appearance settings={settings} activeSkin={shell.activeSkin()} onChange={(p) => shell.update(p)} />
      </div>
    </div>
  );
}
