import { useId, type CSSProperties } from 'react';
import { statusIconBody, type StatusIconName } from '../status-icons.ts';

export interface SpicaStatusIconProps {
  name: StatusIconName;
  /** 边长（px），常用 15–16，跟在文字旁边 */
  size?: number;
  /** 无障碍名称；不给则 aria-hidden（旁边通常有文字） */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * 带圈状态图标。颜色缺省取皮肤的语义色（完成 → 成功色，警告 / 等待确认 / 提问 → 警告色，错误 → 错误色，
 * 进行中 / 提示 → 强调色，已停止 / 排队 → 次要文字色；见 status.css），调用处设了 color 就跟调用处走。
 * 进行中的亮弧会转（减弱动效时不转）。
 */
export function SpicaStatusIcon({ name, size = 16, title, className, style }: SpicaStatusIconProps) {
  const maskId = `spica-status-${useId().replace(/:/g, '')}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `spica-status-icon ${className}` : 'spica-status-icon'}
      data-status={name}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable={false}
      dangerouslySetInnerHTML={{ __html: statusIconBody(name, maskId) }}
    />
  );
}
