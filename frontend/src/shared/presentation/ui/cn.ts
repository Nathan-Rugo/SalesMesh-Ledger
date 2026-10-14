/** Joins truthy class names. */
export const cn = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');
