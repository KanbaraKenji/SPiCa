// 设置 › 常规 › 操作电脑: whether the agent may operate programs on this computer (off by default; off, only that
// row shows), the programs allowed for every conversation (from 始终允许 on an approval card; each can be removed),
// and the restricted programs: the fixed groups (shared/computer-use.ts) and the ones added here (by the exe's name).
import { exeName, onlyThisConversation, RESTRICTED_GROUPS, ruleFor, type Tier } from '../../../shared/computer-use';
import { APP_NAME } from '../../../shared/app-identity';
import { N_, t } from '../../../shared/i18n';
import type { SettingsPatch, ShellSettings } from '../../../shared/settings';
import { Icon } from '../ui/Icon';
import { Group, Row } from './Group';
import { Switch } from './Switch';

/** How far a restricted group may be operated, as the row says it. */
const TIER_LABEL: Record<Tier | 'highRisk', string> = {
  blocked: N_('不允许'),
  view: N_('只看'),
  click: N_('只能点'),
  full: N_('允许'),
  highRisk: N_('高风险'),
};

export function ComputerUse({ settings, onChange, pickFiles }: { settings: ShellSettings; onChange(patch: SettingsPatch): void; pickFiles?: (title?: string) => Promise<string[]> }) {
  const c = settings.computerUse;
  const set = (patch: Partial<typeof c>) => onChange({ computerUse: { ...c, ...patch } });
  // shared and high-risk programs are allowed for one conversation at a time, never listed here
  const always = c.always.filter((a) => !onlyThisConversation(ruleFor(a.exe)));
  const add = () =>
    void pickFiles?.(t('选择程序')).then((files) => {
      const names = files.map(exeName).filter((n) => n.endsWith('.exe') && !c.denied.some((d) => d.toLowerCase() === n));
      if (names.length) set({ denied: [...c.denied, ...names] });
    });
  return (
    <>
      <Group title={t('操作电脑')}>
        <Row title={t('允许 Agent 操作电脑')}>
          <Switch on={c.enabled} label={t('允许 Agent 操作电脑')} onChange={(enabled) => set({ enabled })} />
        </Row>
      </Group>
      {c.enabled && always.length ? (
        <Group title={t('始终允许的程序')}>
          {always.map((a) => (
            <Row key={a.exe} className="computer-app-row" title={<AppName name={a.name} icon={a.icon} />} hint={a.exe} path={{ hint: a.exe }}>
              <button type="button" className="btn btn-square" onClick={() => set({ always: c.always.filter((x) => x.exe !== a.exe) })} aria-label={t('移除 {name}', { name: a.name })} title={t('移除')}>
                <Icon name="close" size={14} />
              </button>
            </Row>
          ))}
        </Group>
      ) : null}
      {c.enabled ? (
        <Group
          title={t('受限的程序')}
          actions={
            pickFiles ? (
              <button type="button" className="btn" onClick={add}>
                {t('添加')}
              </button>
            ) : null
          }
        >
          {RESTRICTED_GROUPS.map((g) => (
            <Row key={g.title} title={t(g.title, { app: APP_NAME })} hint={g.examples.join(t('、'))}>
              <span className="settings-hint">{t(TIER_LABEL[g.tier])}</span>
            </Row>
          ))}
          {c.denied.map((d) => (
            <Row key={d} title={d}>
              <span className="settings-hint">{t(TIER_LABEL.blocked)}</span>
              <button type="button" className="btn btn-square" onClick={() => set({ denied: c.denied.filter((x) => x !== d) })} aria-label={t('移除 {name}', { name: d })} title={t('移除')}>
                <Icon name="close" size={14} />
              </button>
            </Row>
          ))}
        </Group>
      ) : null}
    </>
  );
}

/** A program's name with its small icon (as it was when allowed), when there is one. */
function AppName({ name, icon }: { name: string; icon?: string | undefined }) {
  return (
    <span className="computer-app-name">
      {icon ? <img src={icon} alt="" width={16} height={16} /> : null}
      {name}
    </span>
  );
}
