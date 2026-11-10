import { Icon } from './Icon';

/**
 * An info icon whose note shows on hover (the app's one hover bubble, HoverTips):
 * the one way a label carries a note (field notes in the settings, a model's
 * official price). Inside a <label> pass `decorative` and give the field the
 * note as its aria-description, so the field's name stays the label alone.
 */
export function InfoTip({ text, label, decorative }: { text: string; label?: string; decorative?: boolean }) {
  return decorative ? (
    <span className="info-tip" data-tip={text} aria-hidden>
      <Icon name="info" size={14} />
    </span>
  ) : (
    <span className="info-tip" role="img" aria-label={label ? `${label}：${text}` : text} data-tip={text} tabIndex={0}>
      <Icon name="info" size={14} />
    </span>
  );
}
