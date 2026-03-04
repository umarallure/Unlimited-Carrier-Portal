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

// Optional export of cookies + localStorage (useful for debugging / inspection).
const STORAGE_FILE = env('CARRIER_STORAGE_FILE', path.join(__dirname, 'carrier-auth.json'));

async function gotoWithRetries(page, url) {
  const attempts = Number(env('CARRIER_GOTO_ATTEMPTS', '3'));
  const timeoutMs = Number(env('CARRIER_GOTO_TIMEOUT_MS', '120000'));

  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return;
    } catch (err) {
      lastErr = err;
      const delay = 1000 * i;
      console.log(`Navigation attempt ${i}/${attempts} failed. Waiting ${delay}ms then retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

async function loginOnce() {
  let browser;

  if (USE_PROXY && PROXY_HOST && PROXY_PORT) {
    const server = `http://${PROXY_HOST}:${PROXY_PORT}`;
    console.log(`Using HTTP proxy for login: ${server}`);
    browser = await chromium.launch({
      headless: false, // show browser so you can log in manually
      proxy: {
        server,
        username: PROXY_USER || undefined,
        password: PROXY_PASS || undefined,
      },
    });
  } else {
    console.log('Launching browser without proxy for login.');
    // No proxy – use your normal IP (or system VPN)
    browser = await chromium.launch({
      headless: false,
    });
  }

  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1365, height: 768 },
  });
  const page = await context.newPage();

  const LOGIN_URL = env(
    'CARRIER_LOGIN_URL',
    'https://www.aetnaseniorproducts.com/ssibrokerwebsecure/broker/home.html',
  );

  try {
    console.log(`Opening login page: ${LOGIN_URL}`);
    await gotoWithRetries(page, LOGIN_URL);

    console.log('Log in manually in the browser (including email code).');
    console.log('Once you see the main dashboard/home page, come back to this terminal and press Enter.');

    // Wait for you to press Enter in the terminal
    process.stdin.resume();
    await new Promise((resolve) => {
      process.stdin.once('data', () => resolve());
    });

    // Export a snapshot of cookies + localStorage.
    const state = await context.storageState();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    console.log(`Session saved to ${STORAGE_FILE}`);

    await context.close();
    await browser.close();
    process.exit(0);
  } catch (err) {
    try {
      await context.close();
      await browser.close();
    } catch {
      // ignore
    }
    throw err;
  }
}

loginOnce().catch((err) => {
  console.error('Error in login-once script:', err);
  process.exit(1);
});

