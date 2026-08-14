/**
 * Scrape Americo policy data using a LOCAL persistent Chrome profile (no GoLogin).
 * See americo-scrape-lib.js for the actual scraping logic (shared with the GoLogin
 * variant, scrape-policies-americo-gologin.js) and the output column list.
 *
 * Usage:
 *   npm run carrier:login:americo      (once, to save a session)
 *   npm run carrier:scrape:americo
 *
 * Env:
 *   CARRIER_POLICIES_LIST_URL   default: https://portal.americoagent.com/policies/search
 *   HEADLESS=1                  run without a visible window
 *   SCRAPE_DELAY_MS             base delay between detail-page visits (default 1200)
 *   CARRIER_PROXY_SERVER / CARRIER_PROXY_HOST+PORT / CARRIER_PROXY_USER / CARRIER_PROXY_PASS  (optional)
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

const lib = require('./americo-scrape-lib');
const { env } = lib;

const PROFILE_DIR = path.join(process.cwd(), 'carrier-browser-profile-americo');

let PROXY_SERVER = env('CARRIER_PROXY_SERVER', '') || env('PROXY_SERVER', '');
if (!PROXY_SERVER) {
  const host = env('CARRIER_PROXY_HOST', '') || env('PROXY_HOST', '');
  const port = env('CARRIER_PROXY_PORT', '') || env('PROXY_PORT', '');
  if (host && port) PROXY_SERVER = `http://${host}:${port}`;
}
const PROXY_USER = env('CARRIER_PROXY_USER', '') || env('PROXY_USER', '');
const PROXY_PASS = env('CARRIER_PROXY_PASS', '') || env('PROXY_PASS', '');
const USE_PROXY = !!PROXY_SERVER;

async function createBrowser() {
  const headless = env('HEADLESS', '0') === '1';

  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error(
      'Local Americo profile not found. Run "npm run carrier:login:americo" first to log in and create: ' + PROFILE_DIR
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
  }

  console.log('Launching browser with local profile:', PROFILE_DIR, headless ? '(headless)' : '(visible)');
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

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

  return { browser, page };
}

async function main() {
  const { browser, page } = await createBrowser();
  try {
    await lib.runScrape(page);
    await browser.close();
    console.log('Done.');
  } catch (err) {
    console.error('Error during Americo policy scraping:', err);
    try {
      await browser.close();
    } catch {}
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Top-level scrape error:', err);
  process.exit(1);
});
