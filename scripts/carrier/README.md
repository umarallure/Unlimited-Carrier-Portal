# Carrier login & scrape

Two options: **GoLogin** (cloud profile) or **local persistent profile** (no GoLogin, session stored on disk).

---

## Option A: Local profile (no GoLogin)

Session is stored in `carrier-browser-profile/` so you log in once and reuse.

1. **First time – log in and save session**
   ```bash
   npm run carrier:login:local
   ```
   Browser opens; log in on the carrier site, then press ENTER in the terminal. Session is saved in `carrier-browser-profile/`.

2. **Scrape policies** (uses same profile; no login needed)
   ```bash
   npm run carrier:scrape:local
   ```

**Env (optional):** `CARRIER_LOGIN_URL`, `CARRIER_POLICIES_URL`, `CARRIER_PROXY_SERVER`, `PROXY_USER`, `PROXY_PASS`, `HEADLESS=1` for scrape.

---

## Option B: GoLogin (cloud profile)

## Env vars (.env.local)

- **GOLOGIN_TOKEN** or **GL_API_TOKEN** – GoLogin API token
- **GOLOGIN_PROFILE_ID** or **GOLOGIN_PROFILEID** – Your existing GoLogin profile ID (proxy is taken from the profile in the dashboard only)
- Proxy: use only the profile’s proxy (no CARRIER_PROXY_* from .env). **CARRIER_PROXY_HOST**, **CARRIER_PROXY_PORT** (deprecated) – Proxy host and port. If set (with optional **CARRIER_PROXY_USER**, **CARRIER_PROXY_PASS**, **CARRIER_PROXY_MODE**), the script applies this proxy to the GoLogin profile before launch so the browser uses it with credentials (no “Sign in” popup).
- **GOLOGIN_SKIP_PROXY_CHECK=1** – Skip SDK proxy test; profile proxy still used in browser
- **GOLOGIN_SKIP_HOST_RESOLVER_RULES=1** – Stops the SDK from adding `MAP * 0.0.0.0` so sites load through the proxy (see below)
- **CARRIER_MANUAL_NAVIGATE=1** – Don’t navigate from script; you open the login URL yourself in the browser
- **CARRIER_LOGIN_URL** – Login page URL (default: Aetna broker home)

## If every site shows "connection reset" (ERR_CONNECTION_RESET)

The GoLogin SDK adds `--host-resolver-rules="MAP * 0.0.0.0 , EXCLUDE disp.oxylabs.io , EXCLUDE api.gologin.com"` when a proxy is set. That can make the browser fail to load any site.

1. Add to `.env.local`:
   ```bash
   GOLOGIN_SKIP_HOST_RESOLVER_RULES=1
   ```

2. Apply this one-time edit so the env var is respected (re-apply after `npm install`):

   **File:** `node_modules/gologin/src/gologin.js`  
   **Find (around line 998):**
   ```js
   if (proxy) {
   ```
   **Replace with:**
   ```js
   if (proxy && process.env.GOLOGIN_SKIP_HOST_RESOLVER_RULES !== '1') {
   ```

Then run `npm run carrier:login` again; the browser should load pages through your proxy.

## Proxy

Only the proxy set in your GoLogin profile (dashboard) is used. Set host, port, username, and password there. If the browser shows a proxy sign-in dialog, enter credentials once. They may be cached for the session. “Sign in”