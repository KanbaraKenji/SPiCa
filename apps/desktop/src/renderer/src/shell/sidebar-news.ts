// What the sidebar gets to show what is new: the 收件箱 entry only while a
// plugin that provides mail is on, the dots (new mail, unseen progress
// reports) always, mail plugin or not.
import type { SidebarProps } from './Sidebar';

export function sidebarNews(o: {
  /** The backend has mail and a mail plugin is on. */
  inboxShown: boolean;
  inbox: NonNullable<SidebarProps['inbox']>;
  notes: ReadonlyMap<string, string>;
}): Pick<SidebarProps, 'inbox' | 'notes'> {
  return o.inboxShown ? { inbox: o.inbox, notes: o.notes } : { notes: o.notes };
}
