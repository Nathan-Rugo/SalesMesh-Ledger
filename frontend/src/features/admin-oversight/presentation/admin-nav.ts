import type { NavItem } from '@/shared/presentation/nav';

/** Admin shell destinations (first item is the role home). Mobile tab bar: these + Sign out <= 5. */
export const adminNav: readonly NavItem[] = [
  { href: '/admin', label: 'Oversight', icon: 'radar' },
  { href: '/admin/queue', label: 'Risk queue', icon: 'queue' },
  { href: '/admin/agents', label: 'Agents', icon: 'users' },
  { href: '/admin/account', label: 'Account', icon: 'user' },
];
