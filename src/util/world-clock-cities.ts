/**
 * Cities plotted on the WorldClockMap, plus the deduplicated set of IANA
 * zones the user can pick as the "source" timezone for a scheduled session.
 *
 * Ported from the world-clock prototype.
 */
export interface City {
  name: string;
  country: string;
  tz: string;
  lat: number;
  lng: number;
}

export const CITIES: City[] = [
  { name: 'Avarua',       country: 'Cook Islands', tz: 'Pacific/Rarotonga',          lat: -21.207, lng: -159.775 },
  { name: 'Honolulu',     country: 'USA',          tz: 'Pacific/Honolulu',           lat: 21.3069, lng: -157.858 },
  { name: 'Anchorage',    country: 'USA',          tz: 'America/Anchorage',          lat: 61.2181, lng: -149.900 },
  { name: 'Los Angeles',  country: 'USA',          tz: 'America/Los_Angeles',        lat: 34.0522, lng: -118.243 },
  { name: 'Denver',       country: 'USA',          tz: 'America/Denver',             lat: 39.7392, lng: -104.990 },
  { name: 'Mexico City',  country: 'Mexico',       tz: 'America/Mexico_City',        lat: 19.4326, lng: -99.133 },
  { name: 'Chicago',      country: 'USA',          tz: 'America/Chicago',            lat: 41.8781, lng: -87.629 },
  { name: 'New York',     country: 'USA',          tz: 'America/New_York',           lat: 40.7128, lng: -74.006 },
  { name: 'Toronto',      country: 'Canada',       tz: 'America/Toronto',            lat: 43.6532, lng: -79.383 },
  { name: 'Bogotá',       country: 'Colombia',     tz: 'America/Bogota',             lat: 4.7110,  lng: -74.072 },
  { name: 'São Paulo',    country: 'Brazil',       tz: 'America/Sao_Paulo',          lat: -23.5505, lng: -46.633 },
  { name: 'Buenos Aires', country: 'Argentina',    tz: 'America/Argentina/Buenos_Aires', lat: -34.6037, lng: -58.381 },
  { name: 'Reykjavík',    country: 'Iceland',      tz: 'Atlantic/Reykjavik',         lat: 64.1466, lng: -21.942 },
  { name: 'London',       country: 'UK',           tz: 'Europe/London',              lat: 51.5074, lng: -0.128 },
  { name: 'Lagos',        country: 'Nigeria',      tz: 'Africa/Lagos',               lat: 6.5244,  lng: 3.379 },
  { name: 'Paris',        country: 'France',       tz: 'Europe/Paris',               lat: 48.8566, lng: 2.352 },
  { name: 'Berlin',       country: 'Germany',      tz: 'Europe/Berlin',              lat: 52.5200, lng: 13.405 },
  { name: 'Cairo',        country: 'Egypt',        tz: 'Africa/Cairo',               lat: 30.0444, lng: 31.236 },
  { name: 'Johannesburg', country: 'South Africa', tz: 'Africa/Johannesburg',        lat: -26.2041, lng: 28.047 },
  { name: 'Istanbul',     country: 'Türkiye',      tz: 'Europe/Istanbul',            lat: 41.0082, lng: 28.978 },
  { name: 'Moscow',       country: 'Russia',       tz: 'Europe/Moscow',              lat: 55.7558, lng: 37.617 },
  { name: 'Nairobi',      country: 'Kenya',        tz: 'Africa/Nairobi',             lat: -1.2921, lng: 36.821 },
  { name: 'Tehran',       country: 'Iran',         tz: 'Asia/Tehran',                lat: 35.6892, lng: 51.389 },
  { name: 'Dubai',        country: 'UAE',          tz: 'Asia/Dubai',                 lat: 25.2048, lng: 55.270 },
  { name: 'Karachi',      country: 'Pakistan',     tz: 'Asia/Karachi',               lat: 24.8607, lng: 67.001 },
  { name: 'Mumbai',       country: 'India',        tz: 'Asia/Kolkata',               lat: 19.0760, lng: 72.878 },
  { name: 'Dhaka',        country: 'Bangladesh',   tz: 'Asia/Dhaka',                 lat: 23.8103, lng: 90.412 },
  { name: 'Bangkok',      country: 'Thailand',     tz: 'Asia/Bangkok',               lat: 13.7563, lng: 100.502 },
  { name: 'Jakarta',      country: 'Indonesia',    tz: 'Asia/Jakarta',               lat: -6.2088, lng: 106.846 },
  { name: 'Singapore',    country: 'Singapore',    tz: 'Asia/Singapore',             lat: 1.3521,  lng: 103.820 },
  { name: 'Hong Kong',    country: 'China',        tz: 'Asia/Hong_Kong',             lat: 22.3193, lng: 114.169 },
  { name: 'Beijing',      country: 'China',        tz: 'Asia/Shanghai',              lat: 39.9042, lng: 116.407 },
  { name: 'Manila',       country: 'Philippines',  tz: 'Asia/Manila',                lat: 14.5995, lng: 120.984 },
  { name: 'Seoul',        country: 'South Korea',  tz: 'Asia/Seoul',                 lat: 37.5665, lng: 126.978 },
  { name: 'Tokyo',        country: 'Japan',        tz: 'Asia/Tokyo',                 lat: 35.6762, lng: 139.650 },
  { name: 'Sydney',       country: 'Australia',    tz: 'Australia/Sydney',           lat: -33.8688, lng: 151.209 },
  { name: 'Suva',         country: 'Fiji',         tz: 'Pacific/Fiji',               lat: -18.1248, lng: 178.450 },
  { name: 'Auckland',     country: 'New Zealand',  tz: 'Pacific/Auckland',           lat: -36.8485, lng: 174.763 },
];

export const SOURCE_ZONES: { tz: string; label: string }[] = Array.from(
  new Map(CITIES.map((c) => [c.tz, `${c.name} (${c.country})`])).entries(),
).map(([tz, label]) => ({ tz, label }));
