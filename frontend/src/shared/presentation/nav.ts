import type { IconName } from './ui/icon';

/** One destination in a role shell (bottom tab bar on mobile, rail on desktop). */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
}
