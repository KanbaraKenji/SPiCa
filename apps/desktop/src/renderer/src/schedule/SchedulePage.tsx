// 定时任务 (mock-up) in its two homes: a page in the main area (the sidebar's 定时任务) and a section of the settings.
import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { ContextMenu } from '../ui/ContextMenu';
import { Group } from '../settings/Group';
import { t } from '../../../shared/i18n';
import type { ScheduleItem } from './model';
import { DEMO_FORM } from './demo';
import { emptyForm, ScheduleDialog, ScheduleRows, ScheduleSettingsForm, ScheduleSettingsRows } from './ScheduleViews';

export interface ScheduleHomeProps {
  items: ScheduleItem[];
  now: Date;
  /** The form is open (新建). */
  creating: boolean;
  onCreating(open: boolean): void;
  onToggle(id: string, on: boolean): void;
  onOpenRun(sessionId: string): void;
}

function useRowMenu(props: ScheduleHomeProps) {
  const [menu, setMenu] = useState<{ item: ScheduleItem; anchor: HTMLElement } | null>(null);
  const el = menu ? (
    <ContextMenu
      x={0}
      y={0}
      anchor={menu.anchor}
      items={[
        { label: t('立即运行'), onSelect: () => undefined },
        { label: t('编辑'), onSelect: () => props.onCreating(true) },
        ...(menu.item.runs[0]?.sessionId ? [{ label: t('打开上次运行'), onSelect: () => props.onOpenRun(menu.item.runs[0]!.sessionId!) }] : []),
        { label: t('删除'), danger: true, onSelect: () => undefined },
      ]}
      onClose={() => setMenu(null)}
    />
  ) : null;
  return { el, open: (item: ScheduleItem, anchor: HTMLElement) => setMenu((m) => (m?.anchor === anchor ? null : { item, anchor })) };
}

/** The main-area page: the list, 新建 at its top right; the form is a dialog over it. */
export function SchedulePage(props: ScheduleHomeProps) {
  const menu = useRowMenu(props);
  const open = (s: ScheduleItem) => {
    const sid = s.runs[0]?.sessionId;
    if (sid) props.onOpenRun(sid);
  };
  return (
    <div className="inbox schedule-page">
      <div className="inbox-column">
        <div className="inbox-head">
          <span />
          <div className="inbox-status">
            <button type="button" className="btn btn-primary" onClick={() => props.onCreating(true)}>
              <Icon name="plus" size={14} />
              {t('新建')}
            </button>
          </div>
        </div>
        <ScheduleRows items={props.items.filter((s) => s.output === 'new')} now={props.now} onToggle={props.onToggle} onOpen={open} onMore={menu.open} />
      </div>
      {menu.el}
      {props.creating ? <ScheduleDialog initial={{ ...emptyForm(props.now), ...DEMO_FORM }} onCancel={() => props.onCreating(false)} onSave={() => props.onCreating(false)} /> : null}
    </div>
  );
}

/** 设置 › 定时任务: the same list as rows of a settings box; 新建 turns the page into the form. */
export function ScheduleSettings(props: ScheduleHomeProps) {
  const menu = useRowMenu(props);
  if (props.creating)
    return <ScheduleSettingsForm initial={{ ...emptyForm(props.now), ...DEMO_FORM }} onCancel={() => props.onCreating(false)} onSave={() => props.onCreating(false)} />;
  return (
    <>
      <Group
        actions={
          <button type="button" className="btn btn-primary" onClick={() => props.onCreating(true)}>
            <Icon name="plus" size={14} />
            {t('新建')}
          </button>
        }
      >
        <ScheduleSettingsRows items={props.items.filter((s) => s.output === 'new')} now={props.now} onToggle={props.onToggle} onOpen={(s) => s.runs[0]?.sessionId && props.onOpenRun(s.runs[0].sessionId)} onMore={menu.open} />
      </Group>
      {menu.el}
    </>
  );
}
