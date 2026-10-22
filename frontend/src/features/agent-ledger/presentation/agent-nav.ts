import type { NavItem } from '@/shared/presentation/nav';

/** Agent shell destinations (first item is the role home). Mobile tab bar: these + Sign out <= 5. */
export const agentNav: readonly NavItem[] = [
  { href: '/agent', label: 'Ledger', icon: 'ledger' },
  { href: '/agent/collect', label: 'Request', icon: 'phone' },
  { href: '/agent/payouts', label: 'Payouts', icon: 'wallet' },
  { href: '/agent/account', label: 'Account', icon: 'user' },
];
