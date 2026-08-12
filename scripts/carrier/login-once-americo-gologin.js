const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

const { GologinApi } = require('gologin');

function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

const GOLOGIN_TOKEN = env('GOLOGIN_TOKEN', '') || env('GL_API_TOKEN', '');
const GOLOGIN_PROFILE_ID = env('GOLOGIN_PROFILE_ID', '') || env('GOLOGIN_PROFILEID', '');
const HOME_URL = env('CARRIER_HOME_URL', 'https://portal.americoagent.com/');

async function main() {
  if (!GOLOGIN_TOKEN || !GOLOGIN_PROFILE_ID) {
    throw new Error('Set GOLOGIN_TOKEN and GOLOGIN_PROFILE_ID (the Americo profile) first.');
  }

  const GL = GologinApi({
    token: GOLOGIN_TOKEN,
    profile_id: GOLOGIN_PROFILE_ID,
    writeCookiesFromServer: true,
  });

  console.log('Launching GoLogin profile (visible)...');
  const { browser } = await GL.launch({ profileId: GOLOGIN_PROFILE_ID });

  const page = await browser.newPage();
  console.log('Opening Americo:', HOME_URL);
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (err) {
    console.warn('Navigation warning (continuing anyway):', err.message || err);
  }

  console.log('\nLog in on the Americo site in the browser window that opened.');
  console.log('Take whatever time you need (2FA, email confirmation, etc.).');
  console.log('Once you can see the portal dashboard (not a login page), come back here');
  console.log('and press ENTER to save the session and close the browser.\n');

  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));

  console.log('Saving session to GoLogin profile...');
  await browser.close();
  await GL.exit();
  console.log('Done. Session saved. You can now run scrape-policies-americo-gologin.js.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
