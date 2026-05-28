/**
 * Step 1 of the one-time host consent flow. GET this URL in a browser as
 * ian@sunriselabs.io; it redirects to Google's consent screen with the right
 * scopes and `access_type=offline` so we get back a refresh token.
 *
 * Deploy:  supabase functions deploy meet-oauth-init --project-ref cuxoxcbzgexaaievfqeb --no-verify-jwt
 */

import {
  MEET_SCOPES,
  OAUTH_AUTHORIZE_URL,
  cors,
  json,
  requireEnv,
} from '../_shared/meet-auth.ts';

Deno.serve((req: Request): Response => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  let clientId: string;
  let redirectUri: string;
  try {
    clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
    redirectUri = requireEnv('GOOGLE_OAUTH_REDIRECT_URI');
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // `prompt=consent` forces Google to re-issue a refresh token even if this
  // host has consented before — important so a re-run of the flow refreshes
  // the stored token instead of silently keeping the old one.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: MEET_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });

  return Response.redirect(`${OAUTH_AUTHORIZE_URL}?${params.toString()}`, 302);
});
