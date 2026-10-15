/** The bento's sample escrow hold: 1 h 59 m 42 s left of a 6 h hold (shared by the tile and its ticker). */
export const HOLD_TOTAL_S = 6 * 3600;
export const HOLD_LEFT_S = 1 * 3600 + 59 * 60 + 42;
export const clock = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
/** ISO 8601 duration for <time dateTime>, e.g. 7182 -> "PT1H59M42S". */
export const isoDuration = (s: number) => `PT${Math.floor(s / 3600)}H${Math.floor((s % 3600) / 60)}M${s % 60}S`;
