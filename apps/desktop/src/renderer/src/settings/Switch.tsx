/** An on / off switch; its name is on hover and for screen readers. */
export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={on ? 'switch is-on' : 'switch'} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}
