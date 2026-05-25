/**
 * schedule-invite (Supabase Edge Function).
 *
 * Sends a calendar invite + return link to a person who has committed to a
 * scheduled Syntegrity session. Mirrors the openrouter function's shape: open
 * CORS, secret keys read from the Deno env, single POST endpoint.
 *
 * Deploy:   supabase functions deploy schedule-invite --project-ref <ref> --no-verify-jwt
 * Secrets:  supabase secrets set RESEND_API_KEY=re_...    --project-ref <ref>
 *           supabase secrets set RESEND_FROM='Syntegrity <invites@yourdomain.tld>' --project-ref <ref>
 *
 * HARDENING (prototype only): open CORS, no per-user auth. Before launch,
 * restrict CORS to known origins and/or require Supabase auth so this can't be
 * abused as an open Resend relay against your account.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const MAX_QUESTION_CHARS = 500;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

interface InvitePayload {
  to?: string;
  sessionCode?: string;
  drivingQuestion?: string;
  startUtc?: string;       // ISO
  durationMinutes?: number;
  returnUrl?: string;
  commitToken?: string;    // becomes part of the .ics UID
}

/** Format a JS Date as the iCalendar UTC stamp `YYYYMMDDTHHMMSSZ`. */
function icsStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function buildIcs(p: {
  uid: string; start: Date; end: Date; summary: string; description: string; url: string;
}): string {
  const now = icsStamp(new Date());
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Syntegrity//Schedule Invite//EN',
    'METHOD:REQUEST',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${p.uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${icsStamp(p.start)}`,
    `DTEND:${icsStamp(p.end)}`,
    `SUMMARY:${escapeIcs(p.summary)}`,
    `DESCRIPTION:${escapeIcs(p.description)}`,
    `URL:${p.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function base64(s: string): string {
  // Deno provides btoa for ASCII strings; .ics is ASCII-safe after escaping.
  return btoa(s);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM');
  if (!apiKey || !from) {
    return json({ error: 'Server misconfigured: RESEND_API_KEY / RESEND_FROM not set' }, 500);
  }

  let payload: InvitePayload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { to, sessionCode, drivingQuestion, startUtc, durationMinutes, returnUrl, commitToken } = payload;
  if (!to || !sessionCode || !drivingQuestion || !startUtc || !durationMinutes || !returnUrl || !commitToken) {
    return json({ error: 'Missing required fields (to, sessionCode, drivingQuestion, startUtc, durationMinutes, returnUrl, commitToken)' }, 400);
  }

  const start = new Date(startUtc);
  if (Number.isNaN(start.getTime())) return json({ error: 'Invalid startUtc' }, 400);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const trimmedQ = drivingQuestion.slice(0, MAX_QUESTION_CHARS);
  const summary = `Syntegrity session: ${trimmedQ}`;
  const description = `Driving question: ${trimmedQ}\n\nManage your spot or join the session:\n${returnUrl}`;

  const ics = buildIcs({
    uid: `${commitToken}@syntegrity`,
    start, end, summary, description, url: returnUrl,
  });

  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; color:#111; max-width:560px;">
      <p style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:0.04em;margin:0 0 6px;">Driving question</p>
      <h2 style="margin:0 0 18px;font-weight:600;line-height:1.3;">${escapeIcs(trimmedQ).replace(/\\n/g, '<br/>')}</h2>
      <p style="margin:0 0 6px;">Starts <strong>${start.toUTCString()}</strong></p>
      <p style="margin:0 0 22px;color:#444;">${durationMinutes} minutes</p>
      <p style="margin:0 0 22px;">
        <a href="${returnUrl}" style="background:#4f7cff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">Manage your spot</a>
      </p>
      <p style="font-size:12px;color:#888;margin:0;">A calendar event is attached. From 10 minutes before the start time this link will take you straight into the session lobby.</p>
    </div>
  `;

  let res: Response;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `Syntegrity session — ${trimmedQ.slice(0, 80)}`,
        html,
        attachments: [
          {
            filename: 'syntegrity-session.ics',
            content: base64(ics),
            content_type: 'text/calendar; method=REQUEST; charset=UTF-8',
          },
        ],
      }),
    });
  } catch (e) {
    return json({ error: `Upstream fetch failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: `Resend ${res.status}: ${detail.slice(0, 500)}` }, res.status);
  }

  const data = (await res.json().catch(() => null)) as { id?: string } | null;
  return json({ id: data?.id ?? null });
});
