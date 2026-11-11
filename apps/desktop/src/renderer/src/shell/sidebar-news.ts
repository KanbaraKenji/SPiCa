// The sidebar's 收件箱 entry is there only while a plugin that provides mail is on.
import type { SidebarProps } from './Sidebar';

export function sidebarNews(o: {
  /** The backend has mail and a mail plugin is on. */
  inboxShown: boolean;
  inbox: NonNullable<SidebarProps['inbox']>;
}): Pick<SidebarProps, 'inbox'> {
  return o.inboxShown ? { inbox: o.inbox } : {};
}
