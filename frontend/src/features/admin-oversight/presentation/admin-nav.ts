import type { NavItem } from '@/shared/presentation/nav';

/** Admin shell destinations. #14 adds the risk queue and payout review here. */
export const adminNav: readonly NavItem[] = [{ href: '/admin', label: 'Oversight', icon: 'radar' }];
