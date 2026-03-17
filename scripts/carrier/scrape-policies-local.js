/**
 * Scrape carrier policy documents using the LOCAL persistent browser profile.
 * Uses the same profile dir as login-once-local.js, so run that first to log in once.
 *
 * Usage: npm run carrier:scrape:local
 * Env: CARRIER_POLICIES_URL (required), CARRIER_PROXY_SERVER / PROXY_USER / PROXY_PASS (optional)
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

const PROFILE_DIR = path.join(process.cwd(), 'carrier-browser-profile');
const DOWNLOAD_DIR = path.join(process.cwd(), 'carrier-downloads');

// Proxy: CARRIER_PROXY_SERVER (full URL) or CARRIER_PROXY_HOST + CARRIER_PROXY_PORT (same as GoLogin flow)
let PROXY_SERVER = env('CARRIER_PROXY_SERVER', '') || env('PROXY_SERVER', '');
if (!PROXY_SERVER) {
  const host = env('CARRIER_PROXY_HOST', '') || env('PROXY_HOST', '');
  const port = env('CARRIER_PROXY_PORT', '') || env('PROXY_PORT', '');
  if (host && port) PROXY_SERVER = `http://${host}:${port}`;
}
const PROXY_USER = env('CARRIER_PROXY_USER', '') || env('PROXY_USER', '');
const PROXY_PASS = env('CARRIER_PROXY_PASS', '') || env('PROXY_PASS', '');
const USE_PROXY = !!PROXY_SERVER;

async function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

async function createBrowserWithSession() {
  const headless = env('HEADLESS', '0') === '1';

  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error(
      'Local profile not found. Run "npm run carrier:login:local" first to log in and create the profile at: ' +
        PROFILE_DIR
    );
  }

  const puppeteer = require('puppeteer');

  const launchOptions = {
    headless,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--window-size=1366,768'],
  };

  if (USE_PROXY) {
    launchOptions.args.push(`--proxy-server=${PROXY_SERVER}`);
    console.log('Using proxy:', PROXY_SERVER);
  } else {
    console.log('No proxy configured (set CARRIER_PROXY_HOST + CARRIER_PROXY_PORT or CARRIER_PROXY_SERVER in .env.local)');
  }

  console.log('Launching browser with local profile:', PROFILE_DIR);
  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 768 });

  if (USE_PROXY && (PROXY_USER || PROXY_PASS)) {
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const p = await target.page();
          if (p) await p.authenticate({ username: PROXY_USER, password: PROXY_PASS });
        } catch (_) {}
      }
    });
  }

  const HOME_URL = env(
    'CARRIER_HOME_URL',
    'https://www.aetnaseniorproducts.com/ssibrokerwebsecure/broker/home.html'
  );

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (err) {
    console.warn('Non-fatal navigation error on HOME_URL:', err.message || err);
  }

  if (page.url().includes('/login') || page.url().includes('aimmanageaccount/login')) {
    await browser.close();
    throw new Error(
      'Session appears expired (redirected to login). Run "npm run carrier:login:local" again.'
    );
  }

  return { browser, page };
}

async function scrapePolicies() {
  await ensureDownloadDir();

  const { browser, page } = await createBrowserWithSession();

  try {
    const POLICIES_URL = env('CARRIER_POLICIES_URL', '');
    if (!POLICIES_URL) {
      throw new Error(
        'Missing CARRIER_POLICIES_URL. Set it to the Aetna portal page where policy documents can be downloaded.'
      );
    }

    console.log('Opening policies page:', POLICIES_URL);
    try {
      await page.goto(POLICIES_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch (err) {
      console.warn('Non-fatal navigation error on POLICIES_URL:', err.message || err);
    }

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });

    const policyLinks = await page.$$('[data-test="policy-row-link"]');
    console.log('Found', policyLinks.length, 'policy rows.');

    for (let i = 0; i < policyLinks.length; i += 1) {
      const link = policyLinks[i];
      console.log('Processing policy', i + 1 + '/' + policyLinks.length);

      await link.click();
      await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});

      const downloadBtn = await page.$('[data-test="download-policy"]');
      if (downloadBtn) {
        await downloadBtn.click();
        await new Promise((r) => setTimeout(r, 3000));
      }

      await page.goBack({ waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
    }

    await browser.close();
  } catch (err) {
    console.error('Error during policy scraping:', err);
    try {
      await browser.close();
    } catch (_) {}
    process.exit(1);
  }
}

scrapePolicies().catch((err) => {
  console.error('Top-level scrape error:', err);
  process.exit(1);
});
