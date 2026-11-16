// A row of a form in 设置 (the model form) laid out as the plugin settings form's rows (Group.tsx Row, the same
// classes): the name on the left, what you fill in on the right; `stack` puts a wide control (the model list,
// 请求头) under the name, full width. Unlike Row it is never a 搜索设置 result (the form's 名称 or API Key are not
// settings of their own), and with `label` the whole row is a <label>, which names its one box.
import type { ReactNode } from 'react';

export interface FormRowProps {
  title: ReactNode;
  children: ReactNode;
  /** The row names its one box (a text field): a <label> round it. */
  label?: boolean;
  /** The control under the name, full width. */
  stack?: boolean;
  className?: string;
  controlClassName?: string;
}

export function FormRow({ title, children, label, stack, className, controlClassName }: FormRowProps) {
  const cls = ['field', 'setting-row', 'form-row', stack ? 'is-stack' : '', className ?? ''].filter(Boolean).join(' ');
  const inner = (
    <>
      <span className="setting-text">
        <span className="setting-title">{title}</span>
      </span>
      <span className={['field-control', 'setting-control', 'config-control', controlClassName ?? ''].filter(Boolean).join(' ')}>{children}</span>
    </>
  );
  return label ? <label className={cls}>{inner}</label> : <div className={cls}>{inner}</div>;
}
