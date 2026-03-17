/**
 * Carrier login using a LOCAL persistent browser profile (no GoLogin).
 * Session (cookies, etc.) is stored in ./carrier-browser-profile so you don't
 * need to log in again on the next run.
 *
 * Usage: npm run carrier:login:local
 * Env: CARRIER_LOGIN_URL, CARRIER_PROXY_SERVER (optional), PROXY_USER, PROXY_PASS (if proxy)
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

const CARRIER_LOGIN_URL = env(
  'CARRIER_LOGIN_URL',
  'https://www.aetnaseniorproducts.com/ssibrokerwebsecure/broker/home.html'
);

// Local profile directory (persistent; add to .gitignore)
const PROFILE_DIR = path.join(process.cwd(), 'carrier-browser-profile');

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

async function main() {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    console.log('Created local profile dir:', PROFILE_DIR);
  }

  const puppeteer = require('puppeteer');

  const launchOptions = {
    headless: false,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--window-size=1366,768',
    ],
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

  console.log('Opening carrier login:', CARRIER_LOGIN_URL);
  try {
    await page.goto(CARRIER_LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
  } catch (err) {
    console.warn('Automatic navigation failed:', err.message || err);
    console.log('Browser is open — open this URL manually, then log in:');
    console.log(CARRIER_LOGIN_URL);
  }

  console.log('\nLog in on the carrier site. When you see the dashboard, press ENTER here to close (session is already saved in the local profile).');
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));

  await browser.close();
  console.log('Done. Session is stored in:', PROFILE_DIR);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
