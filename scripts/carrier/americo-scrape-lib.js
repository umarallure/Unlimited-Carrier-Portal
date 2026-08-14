/**
 * Shared scraping logic for Americo policies — reads rows directly off the
 * Policies - Search grid (Policy #, Insured, Agent, Agent #, Product, Policy
 * Status, Status Date, Received Date, Effective Date, Terminated Date,
 * Annualized Premium). No need to open each policy's detail page — that data
 * turned out to already be enough on its own.
 *
 * Used by both scrape-policies-americo.js (local profile) and
 * scrape-policies-americo-gologin.js (GoLogin profile).
 *
 * Output: carrier-downloads/americo-policies-<YYYY-MM-DD>.xlsx, headed "Policy #"
 * first (matches the app's existing policy-number-column auto-detection in
 * lib/fileParser.ts — no changes needed there).
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

const DOWNLOAD_DIR = path.join(process.cwd(), 'carrier-downloads');
const LIST_URL = env('CARRIER_POLICIES_LIST_URL', 'https://portal.americoagent.com/policies/search');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLoginPage(url) {
  return /\/login|signin|sign-in/i.test(url);
}

/**
 * Fill Americo's login form (real selectors, confirmed against the actual
 * ASP.NET Identity login page markup: #txtUsername / #txtPassword / a
 * type="submit" button.login-button) and submit. Only handles the
 * username+password step - 2FA/email confirmation (if Americo challenges
 * the login) still needs a human, same as before; this just removes the
 * "type credentials and click/press enter" step that always came first.
 *
 * Returns false without doing anything if AMERICO_USERNAME/AMERICO_PASSWORD
 * aren't set, or if the page isn't actually showing the login form (e.g.
 * already authenticated) - callers should fall back to the existing
 * prompt-and-wait flow in either case.
 */
async function attemptAutoLogin(page) {
  const username = env('AMERICO_USERNAME', '');
  const password = env('AMERICO_PASSWORD', '');
  if (!username || !password) return false;

  const usernameField = await page.$('#txtUsername');
  if (!usernameField) return false;

  console.log('Login form detected - filling credentials from AMERICO_USERNAME/AMERICO_PASSWORD...');
  await usernameField.click({ clickCount: 3 });
  await usernameField.type(username, { delay: 20 });

  const passwordField = await page.$('#txtPassword');
  if (!passwordField) return false;
  await passwordField.click({ clickCount: 3 });
  await passwordField.type(password, { delay: 20 });

  const submitBtn = await page.$('button.login-button[type="submit"]') || await page.$('button[type="submit"]');
  if (submitBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      submitBtn.click(),
    ]);
  } else {
    // Fall back to Enter-submits-the-form (confirmed working manually) if the
    // button selector ever changes and stops matching.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      passwordField.press('Enter'),
    ]);
  }

  await sleep(1500);
  console.log('Submitted login form. Landed on:', page.url());
  return true;
}

async function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/**
 * Read every row currently in the grid, using the <thead> data-field/data-title
 * attributes to build the column order dynamically (rather than hardcoding cell
 * positions), so it keeps working if Americo reorders/adds a column.
 */
async function extractGridRows(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('#searchGrid') || document.querySelector('#workListGrid');
    if (!grid) return [];

    const headers = Array.from(grid.querySelectorAll('thead th[data-field]')).map((th) => {
      // data-title can contain "<br>" (e.g. "Status<br>Date") — collapse to a
      // single space for a clean column name.
      const raw = th.getAttribute('data-title') || th.getAttribute('data-field') || '';
      return raw.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
    });

    const rows = Array.from(grid.querySelectorAll('tbody tr'));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      const record = {};
      headers.forEach((header, i) => {
        const cell = cells[i];
        record[header] = cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
      });
      return record;
    });
  });
}

/**
 * Page through the Kendo grid, collecting rows from every page. Handles the
 * case where there's no pager at all (everything fits on one page).
 */
async function collectAllGridRows(page) {
  const allRows = [];
  // Real-world safety net: this pagination loop has only ever run against a
  // single-page (55-row) result set where the pager was disabled from the
  // start, so the "click next -> reload -> extract" cycle is unexercised.
  // Cap iterations generously rather than trusting the disabled-state check
  // to never misfire — if this cap is ever hit, something's wrong (stuck page,
  // grid re-rendering unexpectedly) and it's better to stop with a clear
  // warning than loop indefinitely.
  const MAX_PAGES = Number(env('MAX_PAGES', '200'));
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    if (pageCount > MAX_PAGES) {
      console.warn(`  Hit MAX_PAGES (${MAX_PAGES}) - stopping pagination early. Set MAX_PAGES higher if this is a genuinely large result set, or investigate if the pager isn't actually advancing.`);
      break;
    }

    const pageRows = await extractGridRows(page);
    allRows.push(...pageRows);
    console.log(`  Collected ${allRows.length} row(s) so far (page ${pageCount})...`);

    const advanced = await page.evaluate(() => {
      const nextBtn = document.querySelector('.k-pager-nav[title="Go to the next page"]')
        || Array.from(document.querySelectorAll('.k-pager-nav')).find((el) =>
          /next/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || '')
        );
      if (!nextBtn) return false;
      const disabled =
        nextBtn.classList.contains('k-state-disabled') || nextBtn.getAttribute('aria-disabled') === 'true';
      if (disabled) return false;
      nextBtn.click();
      return true;
    });

    if (!advanced) break;

    await page
      .waitForFunction(() => !document.querySelector('.k-loading-mask'), { timeout: 15000 })
      .catch(() => {});
    await sleep(800);
  }

  return allRows;
}

function writeOutputFile(records, dateStr) {
  const ws = XLSX.utils.json_to_sheet(records);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const primaryPath = path.join(DOWNLOAD_DIR, `americo-policies-${dateStr}.xlsx`);
  try {
    XLSX.writeFile(wb, primaryPath);
    console.log(`\nWrote ${records.length} policy record(s) to: ${primaryPath}`);
    return primaryPath;
  } catch (err) {
    if (err.code !== 'EBUSY') throw err;
    // Previous output file is still open in Excel (Windows locks it for writing).
    // Don't lose this run's data over that — write to a timestamped fallback name.
    const fallbackPath = path.join(DOWNLOAD_DIR, `americo-policies-${dateStr}-${Date.now()}.xlsx`);
    console.warn(`\n"${primaryPath}" is open in another program (EBUSY). Writing to "${fallbackPath}" instead — close the other file before the next run.`);
    XLSX.writeFile(wb, fallbackPath);
    console.log(`Wrote ${records.length} policy record(s) to: ${fallbackPath}`);
    return fallbackPath;
  }
}

/**
 * Full run against an already-authenticated page: open the list, submit Search
 * if needed, read every row (across all pages), write the output file.
 */
async function runScrape(page) {
  await ensureDownloadDir();

  console.log('Opening policy list:', LIST_URL);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (isLoginPage(page.url())) {
    throw new Error('Redirected to login. The saved session is not authenticated for Americo — log in again first.');
  }

  // Search (unlike Worklist) doesn't auto-load — it needs its "Search" button
  // (#Apply) clicked before the grid populates, even with blank/default filters.
  const hasSearchButton = await page.$('#Apply');
  if (hasSearchButton) {
    console.log('Search page detected — clicking "Search" (#Apply) with default filters...');
    await hasSearchButton.click();
    await page
      .waitForFunction(() => !document.querySelector('.k-loading-mask'), { timeout: 20000 })
      .catch(() => {});
    await sleep(1000);
  }

  await page.waitForSelector('#searchGrid tbody tr, #workListGrid tbody tr', { timeout: 20000 }).catch(() => {
    console.warn('No policy rows found on the list page within 20s — grid may be empty, need different filters, or the selector changed.');
  });

  console.log('Collecting policy rows (paging through the grid)...');
  let records = await collectAllGridRows(page);
  console.log(`Found ${records.length} policy row(s) total.`);

  if (!records.length) {
    console.warn('No rows collected — nothing to write.');
    return [];
  }

  // Optional cap for a quick test run, e.g. LIMIT=17 to write just a handful of
  // rows and sanity-check the output fast.
  const limit = Number(env('LIMIT', '0'));
  if (limit > 0 && records.length > limit) {
    console.log(`LIMIT=${limit} set — writing only the first ${limit} of ${records.length} rows.`);
    records = records.slice(0, limit);
  }

  const dateStr = env('OUTPUT_DATE', '') || new Date().toISOString().slice(0, 10);
  writeOutputFile(records, dateStr);

  return records;
}

module.exports = {
  env,
  DOWNLOAD_DIR,
  LIST_URL,
  sleep,
  isLoginPage,
  attemptAutoLogin,
  ensureDownloadDir,
  extractGridRows,
  collectAllGridRows,
  writeOutputFile,
  runScrape,
};
