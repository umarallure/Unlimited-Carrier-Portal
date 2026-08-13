/**
 * List your GoLogin profiles (name + id) so you can find the profile ID for a
 * profile you already know by name (e.g. the one logged into Americo) without
 * digging through the GoLogin app UI.
 *
 * Usage: node scripts/carrier/list-gologin-profiles.js
 * Env: GOLOGIN_TOKEN (or GL_API_TOKEN) — already in .env from the Aetna setup.
 */

const path = require('path');
const https = require('https');

require('dotenv').config({ path: path.join(__dirname, '../..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '../..', '.env') });

function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

const TOKEN = env('GOLOGIN_TOKEN', '') || env('GL_API_TOKEN', '');
if (!TOKEN) {
  console.error('Missing GOLOGIN_TOKEN (or GL_API_TOKEN) in .env / .env.local');
  process.exit(1);
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    https
      .get(
        `https://api.gologin.com${urlPath}`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (err) {
                reject(new Error(`Failed to parse response: ${err.message}\n${data.slice(0, 300)}`));
              }
            } else {
              reject(new Error(`GET ${urlPath} -> ${res.statusCode}: ${data.slice(0, 300)}`));
            }
          });
        }
      )
      .on('error', reject);
  });
}

async function main() {
  console.log('Fetching profiles from GoLogin...\n');

  // GoLogin's v2 profile listing endpoint (paginated).
  let all = [];
  let page = 1;
  while (true) {
    const res = await get(`/browser/v2?page=${page}`);
    const profiles = res.profiles || res.data || (Array.isArray(res) ? res : []);
    if (!profiles.length) break;
    all = all.concat(profiles);
    if (profiles.length < 20) break; // last page (default page size is usually 20)
    page += 1;
    if (page > 20) break; // safety cap
  }

  if (!all.length) {
    console.log('No profiles returned. Double-check GOLOGIN_TOKEN is valid.');
    return;
  }

  console.log(`Found ${all.length} profile(s):\n`);
  all
    .map((p) => ({ name: p.name || '(unnamed)', id: p.id }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => console.log(`  ${p.name.padEnd(30)} ${p.id}`));

  console.log('\nCopy the id next to your Americo profile into GOLOGIN_PROFILE_ID.');
}

main().catch((err) => {
  console.error('Failed to list profiles:', err.message);
  console.error('\nFalling back to the GoLogin app: open the profile, click its "..." menu ->');
  console.error('profile settings — the Profile ID is shown there (or in the share link).');
  process.exit(1);
});
