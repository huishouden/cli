// The household tools read the person's day in a frame whose UTC fields are their wall clock
// (@huishouden/pwa-kit/local-clock), so hh runs in UTC: main.ts imports this first, before anything
// makes a Date. The machine's own zone is kept as the last fallback for the person's clock.
export const MACHINE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
process.env.TZ = 'UTC';
