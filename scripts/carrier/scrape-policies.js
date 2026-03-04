const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function env(name, fallback) {
  return process.env[name] && String(process.env[name]).trim() ? String(process.env[name]).trim() : fallback;
}

// Generic HTTP proxy config (e.g. Webshare)
const PROXY_HOST = env('CARRIER_PROXY_HOST', '');
const PROXY_PORT = env('CARRIER_PROXY_PORT', '');
const PROXY_USER = env('CARRIER_PROXY_USER', '');
const PROXY_PASS = env('CARRIER_PROXY_PASS', '');
const USE_PROXY = env('CARRIER_USE_PROXY', '1') === '1';

const STORAGE_FILE = env('CARRIER_STORAGE_FILE', path.join(__dirname, 'carrier-auth.json'));
const DOWNLOAD_DIR = path.join(process.cwd(), 'carrier-downloads');

async function createContextWithSession() {
  const headless = env('HEADLESS', '0') === '1';
  if (!fs.existsSync(STORAGE_FILE)) {
    throw new Error(`No saved session found at ${STORAGE_FILE}. Run "npm run carrier:login" first and log in manually.`);
  }

  let browser;

  if (USE_PROXY && PROXY_HOST && PROXY_PORT) {
    const server = `http://${PROXY_HOST}:${PROXY_PORT}`;
    console.log(`Using HTTP proxy for scrape: ${server}`);
    browser = await chromium.launch({
      headless,
      proxy: {
        server,
        username: PROXY_USER || undefined,
        password: PROXY_PASS || undefined,
      },
    });
  } else {
    console.log('Launching browser without proxy for scrape.');
    browser = await chromium.launch({
      headless,
    });
  }

  const context = await browser.newContext({
    storageState: STORAGE_FILE,
    acceptDownloads: true,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1365, height: 768 },
  });

  const page = await context.newPage();

  const HOME_URL = env(
    'CARRIER_HOME_URL',
    'https://www.aetnaseniorproducts.com/ssibrokerwebsecure/broker/home.html',
  );

  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // If we got bounced back to login, the session is invalid/expired
  if (page.url().includes('/login') || page.url().includes('aimmanageaccount/login')) {
    throw new Error(
      'Saved session appears to be expired (redirected to login). Run "npm run carrier:login" again.',
    );
  }

  return { browser, context, page };
}

async function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

async function scrapePolicies() {
  await ensureDownloadDir();

  const { browser, context, page } = await createContextWithSession();

  try {
    const POLICIES_URL = env('CARRIER_POLICIES_URL', '');
    if (!POLICIES_URL) {
      throw new Error(
        'Missing CARRIER_POLICIES_URL. Set it to the Aetna portal page where policy documents can be downloaded.',
      );
    }
    console.log(`Opening policies page: ${POLICIES_URL}`);

    await page.goto(POLICIES_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // Example selector for policy rows/links – replace with what you see in the DOM
    const policyLinks = await page.$$('[data-test="policy-row-link"]');

    console.log(`Found ${policyLinks.length} policy rows.`);

    for (let i = 0; i < policyLinks.length; i += 1) {
      const link = policyLinks[i];
      console.log(`Processing policy ${i + 1}/${policyLinks.length}`);

      await link.click();
      await page.waitForLoadState('domcontentloaded');

      // Example download button selector – replace with the real selector
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-test="download-policy"]');
      const download = await downloadPromise;

      const suggestedFilename = download.suggestedFilename();
      const targetPath = path.join(DOWNLOAD_DIR, suggestedFilename);
      await download.saveAs(targetPath);

      console.log(`Saved policy to ${targetPath}`);

      // Go back to the list and add a small random delay
      await page.goBack({ waitUntil: 'domcontentloaded' });
      const delay = 1000 + Math.random() * 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    await context.close();
    await browser.close();
  } catch (err) {
    console.error('Error during policy scraping:', err);
    await context.close();
    await browser.close();
    process.exit(1);
  }
}

scrapePolicies().catch((err) => {
  console.error('Top-level scrape error:', err);
  process.exit(1);
});

