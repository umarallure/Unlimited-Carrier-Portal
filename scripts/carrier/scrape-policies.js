const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

const { GologinApi } = require('gologin');
const fs = require('fs');

function env(name, fallback) {
  return process.env[name] && String(process.env[name]).trim() ? String(process.env[name]).trim() : fallback;
}

// Token: GOLOGIN_TOKEN or GL_API_TOKEN (same as official SDK example)
const GOLOGIN_TOKEN = env('GOLOGIN_TOKEN', '') || env('GL_API_TOKEN', '');
const GOLOGIN_PROFILE_ID = env('GOLOGIN_PROFILE_ID', '') || env('GOLOGIN_PROFILEID', '');
const PROXY_USER = env('CARRIER_PROXY_USER', '') || env('PROXY_USER', 'user-LMX_P_N0PoY');
const PROXY_PASS = env('CARRIER_PROXY_PASS', '') || env('PROXY_PASS', '5_vQlWT3~XfrM6S');
const CARRIER_PROXY_HOST = env('CARRIER_PROXY_HOST', '') || env('PROXY_HOST', '');
const CARRIER_PROXY_PORT = env('CARRIER_PROXY_PORT', '') || env('PROXY_PORT', '');
const CARRIER_PROXY_MODE = env('CARRIER_PROXY_MODE', '');
const DOWNLOAD_DIR = path.join(process.cwd(), 'carrier-downloads');

async function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

async function createBrowserWithSession() {
  const headless = env('HEADLESS', '0') === '1';

  if (!GOLOGIN_TOKEN || !GOLOGIN_PROFILE_ID) {
    throw new Error(
      'Set GOLOGIN_TOKEN and GOLOGIN_PROFILE_ID. Use the same profile you used for carrier:login (session is stored in the profile).',
    );
  }

  const GL = GologinApi({
    token: GOLOGIN_TOKEN,
    profile_id: GOLOGIN_PROFILE_ID,
    writeCookiesFromServer: true,
    extra_params: headless ? ['--headless'] : [],
  });

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
  // Otherwise the proxy set in your GoLogin profile is used as-is.

  const skipProxyCheck = env('GOLOGIN_SKIP_PROXY_CHECK', '0') === '1';
  const proxyCheckTimeout = Number(env('GOLOGIN_PROXY_CHECK_TIMEOUT_MS', '30000'));
  const proxyCheckAttempts = Number(env('GOLOGIN_PROXY_CHECK_ATTEMPTS', '5'));

  const launchOptions = {
    profileId: GOLOGIN_PROFILE_ID,
    proxyCheckTimeout,
    proxyCheckAttempts,
  };
  if (skipProxyCheck) {
    launchOptions.timezone = { timezone: 'America/New_York', country: 'US', city: '', ll: [0, 0], accuracy: 0 };
  }

  console.log(headless ? 'Launching GoLogin profile headless (session loaded from profile).' : 'Launching GoLogin profile (session loaded from profile).');
  const { browser } = await GL.launch(launchOptions);

  const proxyAuth = { username: PROXY_USER, password: PROXY_PASS };

  // Use newPage() and authenticate before any navigation (same as working login script)
  const page = await browser.newPage();
  await page.authenticate(proxyAuth);

  // Apply proxy auth to any new tabs/pages (e.g. from clicks)
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const p = await target.page();
        if (p) await p.authenticate(proxyAuth);
      } catch (_) {}
    }
  });

  await page.setViewport({ width: 1365, height: 768 });

  const HOME_URL = env(
    'CARRIER_HOME_URL',
    'https://www.aetnaseniorproducts.com/ssibrokerwebsecure/broker/home.html',
  );

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (err) {
    console.warn('Non-fatal navigation error on HOME_URL (continuing anyway):', err.message || err);
  }

  if (page.url().includes('/login') || page.url().includes('aimmanageaccount/login')) {
    await browser.close();
    await GL.exit();
    throw new Error(
      'Session in GoLogin profile appears expired (redirected to login). Run "npm run carrier:login" again.',
    );
  }

  return { browser, page, GL };
}

async function scrapePolicies() {
  await ensureDownloadDir();

  const { browser, page, GL } = await createBrowserWithSession();

  try {
    const POLICIES_URL = env('CARRIER_POLICIES_URL', '');
    if (!POLICIES_URL) {
      throw new Error(
        'Missing CARRIER_POLICIES_URL. Set it to the Aetna portal page where policy documents can be downloaded.',
      );
    }
    console.log(`Opening policies page: ${POLICIES_URL}`);

    try {
      await page.goto(POLICIES_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch (err) {
      console.warn('Non-fatal navigation error on POLICIES_URL (page may still be loaded):', err.message || err);
    }

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });

    const policyLinks = await page.$$('[data-test="policy-row-link"]');
    console.log(`Found ${policyLinks.length} policy rows.`);

    for (let i = 0; i < policyLinks.length; i += 1) {
      const link = policyLinks[i];
      console.log(`Processing policy ${i + 1}/${policyLinks.length}`);

      await link.click();
      await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});

      const downloadBtn = await page.$('[data-test="download-policy"]');
      if (downloadBtn) {
        await downloadBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      await page.goBack({ waitUntil: 'domcontentloaded' });
      const delay = 1000 + Math.random() * 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    await browser.close();
    await GL.exit();
  } catch (err) {
    console.error('Error during policy scraping:', err);
    try {
      await browser.close();
      await GL.exit();
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

scrapePolicies().catch((err) => {
  console.error('Top-level scrape error:', err);
  if (err.message && err.message.includes('Proxy Error')) {
    console.error('\nTip: Try GOLOGIN_PROXY_CHECK_TIMEOUT_MS and GOLOGIN_PROXY_CHECK_ATTEMPTS, or GOLOGIN_SKIP_PROXY=1.');
  }
  process.exit(1);
});
