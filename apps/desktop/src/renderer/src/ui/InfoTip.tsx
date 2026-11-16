import { Icon, type IconName } from './Icon';

/**
 * An info icon whose note shows on hover (the app's one hover bubble, HoverTips):
 * the one way a label carries a note (field notes in the settings, a model's
 * official price). Inside a <label> pass `decorative` and give the field the
 * note as its aria-description, so the field's name stays the label alone. `icon`: another sign than ⓘ
 * for the same kind of note (🔒 for a field the administrator set).
 */
export function InfoTip({ text, label, decorative, icon = 'info' }: { text: string; label?: string; decorative?: boolean; icon?: IconName }) {
  return decorative ? (
    <span className="info-tip" data-tip={text} aria-hidden>
      <Icon name={icon} size={14} />
    </span>
  ) : (
    <span className="info-tip" role="img" aria-label={label ? `${label}：${text}` : text} data-tip={text} tabIndex={0}>
      <Icon name={icon} size={14} />
    </span>
  );
}
