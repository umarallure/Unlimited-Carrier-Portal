const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

const puppeteer = require('puppeteer');

function env(name, fallback) {
  return process.env[name] && String(process.env[name]).trim() ? String(process.env[name]).trim() : fallback;
}

const DOWNLOAD_DIR = path.join(process.cwd(), 'carrier-downloads');

async function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

async function getAttachedPage() {
  // Default to the port we saw in the logs; allow override
  const remotePort = Number(env('GOLOGIN_REMOTE_PORT', '21879'));
  const browserURL = `http://127.0.0.1:${remotePort}`;

  console.log('Attaching to existing GoLogin browser at:', browserURL);

  const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  const pages = await browser.pages();

  if (!pages.length) {
    throw new Error('No pages found in attached browser.');
  }

  // Use the last tab, per your description
  const page = pages[pages.length - 1];
  return { browser, page };
}

async function ensureLoggedIn(page) {
  // If we're on the login page with autofilled creds, just click Login
  const loginButtonSelector =
    'button.typography-module_buttonprimary__D3tuQ.continueButton.am-login-createaccount-button';

  const isLoginPage = await page.$('#aetnaUserName');
  if (isLoginPage) {
    console.log('Login page detected, clicking Login button...');
    await page.click(loginButtonSelector).catch(() => {});
    // Wait for navigation or dashboard load
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      page.waitForTimeout(8000),
    ]);
  }
}

async function navigateToPolicies(page) {
  const targetUrl = env(
    'CARRIER_POLICIES_URL',
    'https://www.aetnaseniorproducts.com/ssibrokerwebaz/agent/policy/summary?channel=broker',
  );

  if (!page.url().startsWith(targetUrl)) {
    console.log('Navigating to policies page:', targetUrl);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((err) => {
      console.warn('Non-fatal navigation error to policies page:', err.message || err);
    });
  } else {
    console.log('Already on policies page.');
  }
}

async function setAgentToAll(page) {
  await page.waitForSelector('#agent', { timeout: 60000 });
  await page.evaluate(() => {
    const select = document.querySelector('#agent');
    if (!select) return;

    const options = Array.from(select.options || []);
    const allOption = options.find((o) => (o.textContent || '').trim() === 'All');
    if (!allOption) return;

    select.value = allOption.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Give Angular some time to refresh results after changing the filter
  await page.waitForTimeout(5000);
}

async function clickDownloadExcel(page) {
  const downloadBtnSelector = 'button.download-btn';

  await page.waitForSelector(downloadBtnSelector, { timeout: 60000 });

  // Enable downloads to the shared downloads directory
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR,
  });

  console.log('Clicking "Download Excel" button...');
  await page.click(downloadBtnSelector);
  await page.waitForTimeout(15000);
}

async function run() {
  await ensureDownloadDir();

  const { browser, page } = await getAttachedPage();

  try {
    await ensureLoggedIn(page);
    await navigateToPolicies(page);
    await setAgentToAll(page);
    await clickDownloadExcel(page);

    console.log('Done. Excel file should be in:', DOWNLOAD_DIR);
  } catch (err) {
    console.error('Error during attached Aetna Excel download:', err);
    process.exitCode = 1;
  } finally {
    // Do NOT close the attached browser; just disconnect.
    try {
      await browser.disconnect();
    } catch {
      // ignore
    }
  }
}

run().catch((err) => {
  console.error('Top-level attached Aetna Excel download error:', err);
  process.exit(1);
});

