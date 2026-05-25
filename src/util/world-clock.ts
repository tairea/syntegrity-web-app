/**
 * Time helpers for the WorldClockMap component.
 *
 * Ported from the world-clock prototype (~/Desktop/projects/world-clock).
 * All timezone math uses the browser Intl API — no external date libraries.
 */

/**
 * UTC offset (in minutes) for the given IANA zone at a given UTC instant.
 * East of UTC returns positive values. Handles DST automatically via Intl.
 */
export function getZoneOffsetMinutes(utcDate: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - utcDate.getTime()) / 60000);
}

/**
 * Convert a wall-clock time *in a given timezone* to a UTC Date.
 * Refines twice so DST boundaries on either side of the guess resolve.
 */
export function wallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const offset = getZoneOffsetMinutes(new Date(utcMs), timeZone);
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    utcMs = wallAsUtc - offset * 60000;
  }
  return new Date(utcMs);
}

export function formatTimeInZone(utcDate: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(utcDate);
}

export function formatDateInZone(utcDate: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(utcDate);
}

export function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

function dayOfYearUtc(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86_400_000) + 1;
}

/**
 * Subsolar point (longitude, latitude) in degrees at `date`. Approximation
 * good to ~1° — fine for a UI day/night overlay.
 */
export function subsolarPoint(date: Date): { lon: number; lat: number } {
  const n = dayOfYearUtc(date);
  const declRad = (23.44 * Math.PI / 180) * Math.sin((2 * Math.PI * (284 + n)) / 365);
  const lat = (declRad * 180) / Math.PI;
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = (12 - utcHours) * 15;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lon, lat };
}
