const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

const { GologinApi } = require('gologin');
const lib = require('./americo-scrape-lib');
const { env } = lib;

const GOLOGIN_TOKEN = env('GOLOGIN_TOKEN', '') || env('GL_API_TOKEN', '');
const GOLOGIN_PROFILE_ID = env('AMERICO_PROFILE_ID', '') || env('GOLOGIN_PROFILE_ID', '') || env('GOLOGIN_PROFILEID', '');
const PROXY_USER = env('CARRIER_PROXY_USER_AMERICO', '');
const PROXY_PASS = env('CARRIER_PROXY_PASS_AMERICO', '');
const CARRIER_PROXY_HOST = env('CARRIER_PROXY_HOST_AMERICO', '');
const CARRIER_PROXY_PORT = env('CARRIER_PROXY_PORT_AMERICO', '');
const CARRIER_PROXY_MODE = env('CARRIER_PROXY_MODE_AMERICO', '');
const HOME_URL = env('CARRIER_HOME_URL', 'https://portal.americoagent.com/');

/**
 * One launch attempt (headless or headful). Returns whether it landed
 * authenticated, along with the browser/page/GL handles so the caller can
 * either keep using them (success) or close them and try again (failure).
 */
async function launchAndCheckAuth(headless) {
  // NOTE: GologinApi({...}) only ever reads `token` from its options - every
  // other field (profile_id, extra_params, etc.) is silently ignored there.
  // Per-launch options like extra_params belong on GL.launch(launchOptions)
  // instead, since that's what actually flows into the real GoLogin instance
  // that reads them. Passing extra_params here was a real bug: --headless
  // was never reaching the actual browser launch, which is why a window kept
  // showing up even on runs logged as "headless".
  const GL = GologinApi({ token: GOLOGIN_TOKEN });

  const skipProxy = env('GOLOGIN_SKIP_PROXY', '0') === '1';
  if (skipProxy) {
    await GL.changeProfileProxy(GOLOGIN_PROFILE_ID, { mode: 'none' });
  } else if (CARRIER_PROXY_HOST && CARRIER_PROXY_PORT && CARRIER_PROXY_MODE) {
    await GL.changeProfileProxy(GOLOGIN_PROFILE_ID, {
      mode: CARRIER_PROXY_MODE,
      host: CARRIER_PROXY_HOST,
      port: Number(CARRIER_PROXY_PORT),
      username: PROXY_USER,
      password: PROXY_PASS,
    });
  }

  const skipProxyCheck = env('GOLOGIN_SKIP_PROXY_CHECK', '0') === '1';
  const proxyCheckTimeout = Number(env('GOLOGIN_PROXY_CHECK_TIMEOUT_MS', '30000'));
  const proxyCheckAttempts = Number(env('GOLOGIN_PROXY_CHECK_ATTEMPTS', '5'));

  const launchOptions = {
    profileId: GOLOGIN_PROFILE_ID,
    proxyCheckTimeout,
    proxyCheckAttempts,
    writeCookiesFromServer: true,
    extra_params: headless ? ['--headless=new'] : [],
  };
  if (skipProxyCheck) {
    launchOptions.timezone = { timezone: 'America/New_York', country: 'US', city: '', ll: [0, 0], accuracy: 0 };
  }

  console.log(headless ? 'Launching GoLogin profile headless (session loaded from profile).' : 'Launching GoLogin profile (session loaded from profile).');
  const { browser } = await GL.launch(launchOptions);

  const page = await browser.newPage();

  if (PROXY_USER || PROXY_PASS) {
    const proxyAuth = { username: PROXY_USER, password: PROXY_PASS };
    await page.authenticate(proxyAuth);
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const p = await target.page();
          if (p) await p.authenticate(proxyAuth);
        } catch (_) {}
      }
    });
  }

  await page.setViewport({ width: 1365, height: 768 });

  console.log('Opening Americo home:', HOME_URL);
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (err) {
    console.warn('Non-fatal navigation error on HOME_URL (continuing anyway):', err.message || err);
  }

  console.log('Landed on:', page.url());

  // domcontentloaded can fire before a client-side JS redirect (e.g. an
  // expired-session bounce to /login) has actually happened - give it a
  // moment to settle before trusting the URL, then re-check. Without this,
  // a stale session can read as "authenticated" here and only fail later
  // once the actual scrape hits a login wall - looking like a random,
  // unexplained intermittent failure rather than what it actually is.
  await lib.sleep(2500);
  console.log('After settle, landed on:', page.url());

  return { browser, page, GL, authenticated: !lib.isLoginPage(page.url()) };
}

async function closeQuietly({ browser, GL }) {
  try {
    await browser.close();
  } catch {}
  try {
    await GL.exit();
  } catch {}
}

async function createBrowserWithSession() {
  if (!GOLOGIN_TOKEN || !GOLOGIN_PROFILE_ID) {
    throw new Error(
      'Set GOLOGIN_TOKEN and GOLOGIN_PROFILE_ID to the GoLogin profile that is already logged into Americo.'
    );
  }

  // HEADLESS unset (default): try headless first (no visible window), and
  // self-heal to headful once if that lands on a login page - headless is a
  // suspected factor in intermittent auth failures against Americo's bot
  // detection, so this gets the "no window" benefit most runs without just
  // failing outright on the runs where headless trips something.
  // HEADLESS=1: headless only, no headful fallback (e.g. unattended/server
  // contexts with no display to fall back to).
  // HEADLESS=0: headful only, skip the headless attempt entirely.
  const headlessSetting = env('HEADLESS', '');
  const forceHeadful = headlessSetting === '0';
  const forceHeadlessOnly = headlessSetting === '1';
  const firstAttemptHeadless = !forceHeadful;

  let attempt = await launchAndCheckAuth(firstAttemptHeadless);
  let lastAttemptWasHeadless = firstAttemptHeadless;

  if (!attempt.authenticated && firstAttemptHeadless && !forceHeadlessOnly) {
    console.warn('Landed on what looks like a login page while headless. Retrying headful once before giving up...');
    await closeQuietly(attempt);
    attempt = await launchAndCheckAuth(false);
    lastAttemptWasHeadless = false;
  }

  // Still not authenticated, but we already have a visible (headful) browser
  // open from the retry above (or as the only attempt, if HEADLESS=0) - try
  // filling AMERICO_USERNAME/AMERICO_PASSWORD and submitting before falling
  // back to a human prompt. This needs no TTY/human at all, so it runs
  // whenever there's a headful browser to use, independent of the
  // stdin.isTTY check below (which only gates the *human* fallback for
  // whatever's left - normally just 2FA/email confirmation, if Americo
  // challenges this login).
  if (!attempt.authenticated && !lastAttemptWasHeadless) {
    const autoLoginAttempted = await lib.attemptAutoLogin(attempt.page);
    if (autoLoginAttempted) {
      const currentUrl = attempt.page.url();
      if (!lib.isLoginPage(currentUrl) && currentUrl.includes('portal.americoagent.com')) {
        attempt.authenticated = true;
        console.log('Auto-login succeeded - no 2FA challenge this time. Continuing...');
      } else {
        console.log('Credentials submitted automatically. Still need a human for whatever comes next (2FA/email confirmation).');
      }
    } else {
      console.log('Auto-login skipped (AMERICO_USERNAME/AMERICO_PASSWORD not set in .env, or login form not detected) - falling back to manual.');
    }
  }

  // Last resort: still not authenticated after the auto-login attempt above
  // (or auto-login wasn't possible - no AMERICO_USERNAME/AMERICO_PASSWORD
  // set). Offer to log in right here rather than closing the browser and
  // making you run login-once-americo-gologin.js as a separate step. Skipped
  // when there's no visible browser to use (HEADLESS=1 - explicitly
  // unattended) or no human to prompt (stdin isn't a real terminal, e.g. a
  // future cron/server job - blocking on a keypress that will never come
  // would just hang forever).
  if (!attempt.authenticated && !lastAttemptWasHeadless && process.stdin.isTTY) {
    const pollIntervalMs = 3000;
    const maxWaitMs = Number(env('LOGIN_WAIT_TIMEOUT_MS', '600000')); // 10 min default
    console.log('\nNot logged in yet. Check the browser window that opened - if credentials were');
    console.log('submitted automatically above, this is likely just a 2FA/email confirmation step;');
    console.log('otherwise log in manually. Take whatever time you need - this continues automatically');
    console.log(`once you're back on the portal (checking every ${pollIntervalMs / 1000}s, up to ${Math.round(maxWaitMs / 60000)} min).\n`);

    // Passive polling only - never force-navigate the page while waiting, so
    // an in-progress 2FA/email-confirmation form the user is actively filling
    // out is never disrupted. Requires landing back on the actual portal
    // domain (not just "any non-login URL") so an unrelated intermediate
    // identity/verification screen along the way can't be mistaken for success.
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await lib.sleep(pollIntervalMs);
      const currentUrl = attempt.page.url();
      if (!lib.isLoginPage(currentUrl) && currentUrl.includes('portal.americoagent.com')) {
        attempt.authenticated = true;
        console.log('Detected successful login. Continuing...');
        break;
      }
    }

    if (!attempt.authenticated) {
      console.warn(`Still not logged in after waiting ${Math.round(maxWaitMs / 60000)} min.`);
    }
  }

  if (!attempt.authenticated) {
    if (!lastAttemptWasHeadless) {
      console.log('This looks like a login page. Leaving the browser open for 15s so you can check it...');
      await new Promise((r) => setTimeout(r, 15000));
    }
    await closeQuietly(attempt);
    throw new Error(
      'This GoLogin profile is not authenticated for Americo (redirected to login)' +
      (firstAttemptHeadless && !forceHeadlessOnly ? ', even after retrying headful and prompting to log in.' : '.') +
      ' Log into portal.americoagent.com inside that GoLogin profile (npm run carrier:login:americo:gologin), then rerun this script.'
    );
  }

  return { browser: attempt.browser, page: attempt.page, GL: attempt.GL };
}

async function main() {
  const { browser, page, GL } = await createBrowserWithSession();
  try {
    await lib.runScrape(page);
    await browser.close();
    await GL.exit();
    console.log('Done.');
  } catch (err) {
    console.error('Error during Americo policy scraping:', err);
    try {
      await browser.close();
      await GL.exit();
    } catch {}
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Top-level scrape error:', err);
  if (err.message && err.message.includes('Proxy Error')) {
    console.error('\nTip: Try GOLOGIN_PROXY_CHECK_TIMEOUT_MS and GOLOGIN_PROXY_CHECK_ATTEMPTS, or GOLOGIN_SKIP_PROXY=1.');
  }
  process.exit(1);
});
