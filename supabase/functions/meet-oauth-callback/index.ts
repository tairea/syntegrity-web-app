/**
 * Step 2 of the one-time host consent flow. Google redirects here with ?code=...
 * after the host approves. We swap the code for { access_token, refresh_token }
 * via the token endpoint, then call OIDC userinfo with the access token to learn
 * which host_email just consented. Refresh token is upserted into
 * meet_credentials keyed by host_email.
 *
 * After a successful exchange the user sees a small HTML confirmation page
 * (this is a one-time human-facing flow, not a JSON API).
 *
 * Deploy:  supabase functions deploy meet-oauth-callback --project-ref cuxoxcbzgexaaievfqeb --no-verify-jwt
 */

import {
  OAUTH_TOKEN_URL,
  OPENID_USERINFO_URL,
  cors,
  getServiceClient,
  json,
  requireEnv,
} from '../_shared/meet-auth.ts';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface UserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
     <style>body{font-family:system-ui,sans-serif;background:#0b0e16;color:#e6ecff;padding:3rem;max-width:640px;margin:auto;line-height:1.5}
     code{background:#11141f;padding:2px 6px;border-radius:4px}h1{color:#9fb0d8}</style></head>
     <body><h1>${title}</h1>${body}</body></html>`,
    { status, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    return htmlPage('Consent denied', `<p>Google returned <code>${oauthError}</code>. You can retry by visiting <code>/meet-oauth-init</code> again.</p>`, 400);
  }
  if (!code) return htmlPage('Missing code', '<p>No <code>code</code> parameter on the callback URL.</p>', 400);

  let clientId: string;
  let clientSecret: string;
  let redirectUri: string;
  try {
    clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
    clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');
    redirectUri = requireEnv('GOOGLE_OAUTH_REDIRECT_URI');
  } catch (e) {
    return htmlPage('Misconfigured', `<p>${(e as Error).message}</p>`, 500);
  }

  // Exchange code → tokens
  const tokenBody = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });
  const tokens = (await tokenRes.json().catch(() => null)) as TokenResponse | null;
  if (!tokenRes.ok || !tokens?.access_token) {
    const detail = tokens?.error_description ?? tokens?.error ?? `HTTP ${tokenRes.status}`;
    return htmlPage('Token exchange failed', `<p><code>${detail}</code></p>`, 502);
  }
  if (!tokens.refresh_token) {
    // Happens if the host has previously consented and Google decided not to
    // re-issue a refresh token. `prompt=consent` in meet-oauth-init should
    // prevent this; surface a clear message if it still happens.
    return htmlPage(
      'No refresh token returned',
      '<p>Google did not return a refresh token. Revoke the app at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and re-run <code>/meet-oauth-init</code>.</p>',
      502,
    );
  }

  // Identify the host
  const userInfoRes = await fetch(OPENID_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = (await userInfoRes.json().catch(() => null)) as UserInfo | null;
  if (!userInfoRes.ok || !userInfo?.email) {
    return htmlPage('userinfo failed', `<p>Could not read host email from Google. HTTP ${userInfoRes.status}.</p>`, 502);
  }

  // Upsert into meet_credentials
  const supabase = getServiceClient();
  const { error: upsertError } = await supabase
    .from('meet_credentials')
    .upsert(
      {
        host_email: userInfo.email,
        refresh_token: tokens.refresh_token,
        scopes: tokens.scope ?? '',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'host_email' },
    );
  if (upsertError) {
    return htmlPage('DB upsert failed', `<p><code>${upsertError.message}</code></p>`, 500);
  }

  return htmlPage(
    'Connected',
    `<p>Stored Meet refresh token for <code>${userInfo.email}</code>.</p>
     <p>Granted scopes: <code>${tokens.scope ?? ''}</code></p>
     <p>You can close this tab.</p>`,
  );
});
