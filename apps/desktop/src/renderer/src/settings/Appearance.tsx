// Settings > 外观: pick a skin, make your own (background + accent), zoom.
import { useRef, useState, type ReactNode } from 'react';
import { BUILTIN_SKINS, DARK_SKIN, deriveTokens, LIGHT_SKIN, normalizeHex, type Skin, type SkinChoice } from '../../../shared/skin';
import { DEFAULT_ZOOM, stepZoom, ZOOM_STEPS, zoomLabel } from '../../../shared/zoom';
import type { SettingsPatch, ShellSettings, SplashMode } from '../../../shared/settings';
import { ConfirmDialog } from '../ui/Dialog';
import { CodeThemes } from './CodeThemes';
import { Icon } from '../ui/Icon';

const SPLASH_OPTIONS: { mode: SplashMode; label: string }[] = [
  { mode: 'daily', label: '每天首次' },
  { mode: 'always', label: '每次' },
  { mode: 'never', label: '从不' },
];

const ACCENT_PRESETS = ['#2f7de1', '#39c5bb', '#7c5cff', '#e0559a', '#e8833a', '#3aa55c'];

function SkinPreview({ skin }: { skin: Skin }) {
  const t = deriveTokens(skin);
  return (
    <span className="skin-preview" style={{ background: t['--spica-bg'], borderColor: t['--spica-border'] }} aria-hidden>
      <span className="skin-preview-side" style={{ background: t['--spica-chrome'] }} />
      <span className="skin-preview-lines">
        <span style={{ background: t['--spica-ink'], width: '70%' }} />
        <span style={{ background: t['--spica-muted'], width: '50%' }} />
        <span style={{ background: t['--spica-accent'], width: '30%' }} />
      </span>
    </span>
  );
}

function SystemPreview() {
  return (
    <span className="skin-preview skin-preview-split" aria-hidden>
      <SkinPreview skin={LIGHT_SKIN} />
      <SkinPreview skin={DARK_SKIN} />
    </span>
  );
}

export function newSkinId(existing: readonly Skin[]): string {
  let n = existing.length + 1;
  while (existing.some((s) => s.id === `custom-${n}`)) n++;
  return `custom-${n}`;
}

export function newSkinName(existing: readonly Skin[]): string {
  let n = 1;
  while (existing.some((s) => s.name === `我的皮肤 ${n}`)) n++;
  return `我的皮肤 ${n}`;
}

function ColorField({ label, value, onChange, presets }: { label: string; value: string; onChange(v: string): void; presets?: string[] }) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setDraft(value);
  }
  const commit = () => {
    const hex = normalizeHex(draft);
    if (hex) onChange(hex);
    else setDraft(value);
  };
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="color-field">
        <input type="color" className="color-swatch" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label}取色`} />
        <input
          className="input input-hex"
          value={draft}
          spellCheck={false}
          aria-label={`${label}色值`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        {presets ? (
          <div className="color-presets">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                className={p === value ? 'color-preset is-on' : 'color-preset'}
                style={{ background: p }}
                onClick={() => onChange(p)}
                aria-label={`使用 ${p}`}
                title={p}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Saves as you type; an emptied field goes back to the last name when it loses focus. */
function NameField({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [draft, setDraft] = useState(value);
  return (
    <input
      className="input"
      value={draft}
      maxLength={40}
      aria-label="皮肤名称"
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value.trim()) onCommit(e.target.value.trim());
      }}
      onBlur={() => {
        if (!draft.trim()) setDraft(value);
      }}
    />
  );
}

export interface AppearanceProps {
  settings: ShellSettings;
  activeSkin: Skin;
  onChange(patch: SettingsPatch): void;
}

export function Appearance({ settings, activeSkin, onChange }: AppearanceProps) {
  const [deleting, setDeleting] = useState<Skin | null>(null);
  const custom = settings.customSkins;
  const editing = custom.find((s) => s.id === settings.skin);

  const choose = (choice: SkinChoice) => onChange({ skin: choice });
  // A double click makes one skin, not two (the list has not been redrawn between the clicks).
  const lastCreate = useRef(0);
  const create = () => {
    if (Date.now() - lastCreate.current < 600) return;
    lastCreate.current = Date.now();
    const skin: Skin = { id: newSkinId(custom), name: newSkinName(custom), bg: activeSkin.bg, accent: activeSkin.accent };
    onChange({ customSkins: [...custom, skin], skin: skin.id });
  };
  const edit = (patch: Partial<Skin>) => {
    if (!editing) return;
    onChange({ customSkins: custom.map((s) => (s.id === editing.id ? { ...s, ...patch } : s)) });
  };
  const remove = (skin: Skin) => {
    const rest = custom.filter((s) => s.id !== skin.id);
    onChange({ customSkins: rest, skin: settings.skin === skin.id ? 'system' : settings.skin });
    setDeleting(null);
  };

  const tiles: { id: SkinChoice; name: string; preview: ReactNode }[] = [
    { id: 'system', name: '跟随系统', preview: <SystemPreview /> },
    ...BUILTIN_SKINS.map((s) => ({ id: s.id, name: s.name, preview: <SkinPreview skin={s} /> })),
    ...custom.map((s) => ({ id: s.id, name: s.name, preview: <SkinPreview skin={s} /> })),
  ];

  const zoomIndex = ZOOM_STEPS.indexOf(settings.zoom as (typeof ZOOM_STEPS)[number]);
  return (
    <section className="settings-section">

      <div className="settings-group">
        <h3 className="settings-subheading">皮肤</h3>
        <div className="skin-grid" role="radiogroup" aria-label="皮肤">
          {tiles.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={settings.skin === t.id}
              className={settings.skin === t.id ? 'skin-tile is-on' : 'skin-tile'}
              onClick={() => choose(t.id)}
            >
              {t.preview}
              <span className="skin-name">{t.name}</span>
            </button>
          ))}
          <button type="button" className="skin-tile skin-tile-new" onClick={create}>
            <span className="skin-preview skin-preview-new" aria-hidden>
              <Icon name="plus" size={18} />
            </span>
            <span className="skin-name">新建皮肤</span>
          </button>
        </div>

        {editing ? (
          <div className="skin-editor">
            <div className="field">
              <span className="field-label">名称</span>
              <NameField key={editing.id} value={editing.name} onCommit={(name) => edit({ name })} />
            </div>
            <ColorField label="底色" value={editing.bg} onChange={(bg) => edit({ bg })} />
            <ColorField label="强调色" value={editing.accent} onChange={(accent) => edit({ accent })} presets={ACCENT_PRESETS} />
            <div className="skin-editor-foot">
              <button type="button" className="btn btn-quiet-danger btn-square" onClick={() => setDeleting(editing)} aria-label="删除皮肤" title="删除皮肤">
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <h3 className="settings-subheading">代码</h3>
        <CodeThemes value={settings.codeTheme} onChange={(codeTheme) => onChange({ codeTheme })} size={settings.codeSize} onSize={(codeSize) => onChange({ codeSize })} />
      </div>

      <div className="settings-group">
        <h3 className="settings-subheading">缩放</h3>
        <div className="zoom-row">
          <div className="stepper" role="group" aria-label="缩放">
            <button type="button" className="icon-btn" onClick={() => onChange({ zoom: stepZoom(settings.zoom, 'out') })} disabled={zoomIndex <= 0} aria-label="缩小" title="缩小">
              <Icon name="minus" size={14} />
            </button>
            <span className="stepper-value num" aria-live="polite">
              {zoomLabel(settings.zoom)}
            </span>
            <button type="button" className="icon-btn" onClick={() => onChange({ zoom: stepZoom(settings.zoom, 'in') })} disabled={zoomIndex >= ZOOM_STEPS.length - 1} aria-label="放大" title="放大">
              <Icon name="plus" size={14} />
            </button>
          </div>
          <button type="button" className="btn" onClick={() => onChange({ zoom: DEFAULT_ZOOM })} disabled={settings.zoom === DEFAULT_ZOOM}>
            恢复 100%
          </button>
        </div>
      </div>

      <div className="settings-group">
        <h3 className="settings-subheading">开机动画</h3>
        <div className="segmented" role="radiogroup" aria-label="开机动画">
          {SPLASH_OPTIONS.map((o) => (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={settings.splash === o.mode}
              className={settings.splash === o.mode ? 'segment is-on' : 'segment'}
              onClick={() => onChange({ splash: o.mode })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {deleting ? <ConfirmDialog title={`删除皮肤「${deleting.name}」？`} confirmLabel="删除" danger onConfirm={() => remove(deleting)} onCancel={() => setDeleting(null)} /> : null}
    </section>
  );
}
