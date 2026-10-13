import type { SVGProps } from 'react';

const PATHS = {
  ledger: 'M4 5h16M4 12h16M4 19h10M17 17l2 2 3-4',
  shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  logout: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l-5-5 5-5M5 12h11',
  offline: 'M2 8.5a15 15 0 0120 0M5.5 12a10 10 0 0113 0M9 15.5a5 5 0 016 0M12 19h.01M3 3l18 18',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  alert: 'M12 3l10 18H2L12 3zM12 10v4M12 17.5h.01',
  check: 'M5 12.5l4.5 4.5L19 7',
  close: 'M6 6l12 12M18 6L6 18',
  radar: 'M12 12l6-6M12 21a9 9 0 110-18M12 17a5 5 0 110-10',
} as const;

export type IconName = keyof typeof PATHS;

/** Line icon. Decorative by default; pass `title` only when the icon carries meaning on its own. */
export function Icon({ name, title, ...props }: { name: IconName; title?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
