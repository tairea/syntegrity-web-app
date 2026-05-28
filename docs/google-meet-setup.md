# Google Meet API — one-time setup

The "Transcribed Sessions" feature creates Google Meet rooms on demand, turns on
transcription at creation, and pulls the transcript Docs from the host's Drive
once each meeting ends. All of that runs through the Supabase Edge Functions
under `supabase/functions/meet-*` using the **host's** OAuth refresh token
(host = ian@sunriselabs.io).

The host has to do the GCP Console steps once. After that, the consent flow runs
once in a browser to mint the refresh token, and the app is self-sufficient.

Supabase project ref (from openrouter deploy notes): `cuxoxcbzgexaaievfqeb`.
Supabase functions base URL: `https://cuxoxcbzgexaaievfqeb.functions.supabase.co`.

---

## 1. Create / pick a GCP project (2 min)

1. Open https://console.cloud.google.com — make sure the top bar shows your
   `sunriselabs.io` Workspace account, not a personal `@gmail.com`.
2. Top-left project dropdown → **New Project**.
   - Name: `syntegrity-meet` (any name; this is the project the Meet API runs under).
   - Organization: `sunriselabs.io` (this is what gates Workspace-internal OAuth).
   - Location: same org.
3. Wait for the project to be created, then make sure it is selected in the top bar.

## 2. Enable the APIs we need (2 min)

In **APIs & Services → Library**, search for and **Enable** each of:

- **Google Meet API**
- **Google Drive API** (needed to download the transcript Doc)
- **Google Workspace Events API** _(optional for MVP — only needed if/when we
  switch from polling transcripts to push notifications via Pub/Sub)_

## 3. Configure the OAuth consent screen (2 min)

**APIs & Services → OAuth consent screen**:

- **User type**: **Internal**. (Workspace-internal means only `sunriselabs.io`
  accounts can grant consent — perfect, we only want ian@ to.)
- App name: `Syntegrity Sessions`.
- User support email + Developer contact: `ian@sunriselabs.io`.
- App domain / privacy policy / terms-of-service: leave blank for internal apps.
- **Scopes** — click **Add or Remove Scopes** and add these five:
  - `https://www.googleapis.com/auth/meetings.space.created`
  - `https://www.googleapis.com/auth/meetings.space.readonly`
  - `https://www.googleapis.com/auth/drive.readonly`
  - `openid`
  - `email`

  (`openid email` are needed so the callback can call Google's `userinfo`
  endpoint and key the stored refresh token by your host email.)
- Save and continue. Internal apps don't need test users or verification.

## 4. Create the OAuth client credential (1 min)

**APIs & Services → Credentials → Create Credentials → OAuth client ID**:

- **Application type**: **Web application**.
- Name: `Syntegrity Meet (server)`.
- **Authorized JavaScript origins** — leave blank. (Our flow is server-side;
  Google redirects to a Supabase edge function, not back into the SPA.)
- **Authorized redirect URIs** — add this exact URL:
  ```
  https://cuxoxcbzgexaaievfqeb.functions.supabase.co/meet-oauth-callback
  ```
- Click **Create**. A dialog shows your **Client ID** and **Client secret**.
  Copy both somewhere safe (you can also re-download them later from the
  credential row).

## 5. Push the credentials into Supabase as secrets (1 min)

From a terminal where you have the Supabase CLI logged in:

```bash
supabase secrets set \
  GOOGLE_OAUTH_CLIENT_ID="<paste client id>" \
  GOOGLE_OAUTH_CLIENT_SECRET="<paste client secret>" \
  GOOGLE_OAUTH_REDIRECT_URI="https://cuxoxcbzgexaaievfqeb.functions.supabase.co/meet-oauth-callback" \
  --project-ref cuxoxcbzgexaaievfqeb
```

The edge functions read all three via `Deno.env.get(...)` at runtime, mirroring
the `OPENROUTER_API_KEY` pattern in `supabase/functions/openrouter/index.ts`.

## 6. Run the one-time consent flow (1 min)

After I deploy `meet-oauth-init` and `meet-oauth-callback`, you visit:

```
https://cuxoxcbzgexaaievfqeb.functions.supabase.co/meet-oauth-init
```

…sign in as `ian@sunriselabs.io`, approve the three scopes. `meet-oauth-callback`
exchanges the code for a refresh token and writes it to a tiny
`meet_credentials` table in the database (keyed by host email). From that point
on, every `meet-create-rooms` / `meet-end-rooms` / `meet-fetch-transcript` call
re-uses that refresh token to mint short-lived access tokens.

If the refresh token is ever revoked (or you revoke the app at
https://myaccount.google.com/permissions), just re-run step 6.

---

## How to verify it worked

After step 6, you can confirm the refresh token landed by querying the table
from the Supabase SQL editor:

```sql
select host_email, scopes, updated_at
  from meet_credentials
  where host_email = 'ian@sunriselabs.io';
```

`refresh_token` column should be non-null and `scopes` should contain all three
URIs you authorized. Then a one-off curl against the create-rooms function (I
will give you the exact incantation when that function is deployed) should
return a live `https://meet.google.com/...` URL.

---

## Cost sanity check

- Meet API + Workspace Events API: **free** (included with Workspace).
- Drive API: **free** at our volume (a few file downloads per session).
- Transcription: **free** as long as the host's Workspace plan is Business
  Standard or higher (sunriselabs.io is — we verified).
- Pub/Sub (if/when we switch to push notifications): well within the free tier.

Effective marginal cost per session: **$0**.
