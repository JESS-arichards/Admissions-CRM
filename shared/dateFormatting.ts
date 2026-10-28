// Canonical source: Applications-Portal. Run scripts/sync-date-formatting.mjs after changing this policy.
export const DATE_DISPLAY_POLICY = {
  locale: 'en-GB',
  short: { day: '2-digit', month: '2-digit', year: 'numeric' },
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  dayMonth: { day: '2-digit', month: '2-digit' },
  weekdayDate: { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' },
} as const;

export type DisplayDate = string | number | Date;
export type DateStyle = 'short' | 'long' | 'dayMonth' | 'weekdayDate';

function displayInput(value: DisplayDate) {
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = value instanceof Date ? value : new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(date.getTime()) || (dateOnly && date.toISOString().slice(0, 10) !== value))
    throw new RangeError('Cannot display an invalid date.');
  return { date, dateOnly };
}

export function formatDate(value: DisplayDate, style: DateStyle | Intl.DateTimeFormatOptions = 'short', options: Intl.DateTimeFormatOptions = {}): string {
  const { date, dateOnly } = displayInput(value);
  const fields = typeof style === 'string' ? DATE_DISPLAY_POLICY[style] : style;
  return new Intl.DateTimeFormat(DATE_DISPLAY_POLICY.locale, {
    ...fields, ...options, ...(dateOnly ? { timeZone: 'UTC' } : {}),
  }).format(date);
}

export function formatDateTime(value: DisplayDate, options: Intl.DateTimeFormatOptions = {}): string {
  if (options.dateStyle || options.timeStyle)
    return formatDate(value, { dateStyle: 'short', timeStyle: 'short', ...options });
  return formatDate(value, {
    ...DATE_DISPLAY_POLICY.short, hour: '2-digit', minute: '2-digit',
    ...options,
  });
}

export function formatTime(value: DisplayDate, options: Intl.DateTimeFormatOptions = {}): string {
  return formatDate(value, { ...(options.timeStyle || options.dateStyle ? {} : { hour: '2-digit', minute: '2-digit' }), ...options });
}
