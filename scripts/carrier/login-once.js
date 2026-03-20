const path = require("path");
const fs = require("fs");

require("dotenv").config({ path: path.join(__dirname, "../..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "../..", ".env") });

const { GologinApi } = require("gologin");

function env(name, fallback) {
  return process.env[name] && String(process.env[name]).trim()
    ? String(process.env[name]).trim()
    : fallback;
}

const PROFILES = {
  heritage: {
    profileId: "69a9c9ff08c290038c0862e2",
    filename: "heritage_aetna_policy.xlsx",
  },
  unlimited: {
    profileId: "69b996d73a196a978b0947ba",
    filename: "unlimited_aetna_policy.xlsx",
  },
  safeharbour: {
    profileId: "69b974b21100b9c62d8860d7",
    filename: "safeharbour_aetna_policy.xlsx",
  },
};

const profileArg = (process.argv.find((a) => a.startsWith("--profile=")) || "").split("=")[1] || "heritage";
const profileConfig = PROFILES[profileArg];
if (!profileConfig) {
  console.error(`Unknown profile "${profileArg}". Available: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}

const useCloud = process.argv.includes("--cloud");

console.log(`Using profile: ${profileArg} (${profileConfig.profileId}) → ${profileConfig.filename}`);
console.log(`Mode: ${useCloud ? "CLOUD" : "LOCAL"}`);

const GOLOGIN_TOKEN = env("GOLOGIN_TOKEN");
const GOLOGIN_PROFILE_ID = profileConfig.profileId;

const SKIP_PROXY_CHECK = env("GOLOGIN_SKIP_PROXY_CHECK", "0") === "1";

const CARRIER_LOGIN_URL = env(
  "CARRIER_LOGIN_URL",
  "https://www.aetnaseniorproducts.com/ssibrokerwebsecure/broker/home.html"
);

const POLICIES_URL = env(
  "CARRIER_POLICIES_URL",
  "https://www.aetnaseniorproducts.com/ssibrokerwebaz/agent/policy/summary?channel=broker"
);

const PROXY_USER = env("PROXY_USER", "user-LMX_P_N0PoY");
const PROXY_PASS = env("PROXY_PASS", "5_vQlWT3~XfrM6S");

const DOWNLOAD_DIR = path.join(process.cwd(), "carrier-downloads");
const POLICY_BASENAME = profileConfig.filename;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait for page to fully settle — no more network activity and no more JS redirects
async function waitForPageToSettle(page, label = "") {
  const tag = label ? `[${label}]` : "";
  console.log(`${tag} Waiting for page to fully load...`);

  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  } catch {}

  // Extra wait for any late JS redirects
  await sleep(3000);

  // Check if a JS redirect is still happening
  for (let i = 0; i < 5; i++) {
    const url = page.url();
    await sleep(2000);
    const urlAfter = page.url();
    if (url === urlAfter) break;
    console.log(`${tag} Page still redirecting... (${urlAfter})`);
  }

  console.log(`${tag} Page settled on: ${page.url()}`);
}

function isLoginPage(url) {
  return url.includes("/login") || url.includes("ssologin") || url.includes("ssibrokerwebsecure/broker/home");
}

function isPoliciesPage(url) {
  return url.includes("ssibrokerwebaz/agent/policy/summary");
}

// Detect login page and handle auto-login. Returns true if login was performed.
async function handleLoginIfNeeded(page) {
  const url = page.url();

  // Check for the login form
  const loginInput = await page.$("#aetnaUserName").catch(() => null);
  if (!loginInput) return false;

  console.log("Login page detected at:", url);
  console.log("Waiting for credentials to autofill...");
  await sleep(5000);

  const loginBtnSelector = 'button[name="Login"][type="submit"]';
  try {
    await page.waitForSelector(loginBtnSelector, { timeout: 15000 });
  } catch {
    console.error("Login button not found.");
    return false;
  }

  console.log("Clicking Login button...");
  await page.click(loginBtnSelector);

  // Wait for navigation after login
  await Promise.race([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
    sleep(20000),
  ]);

  // Extra settle time for post-login redirects
  await sleep(5000);

  const stillOnLogin = await page.$("#aetnaUserName").catch(() => null);
  if (stillOnLogin) {
    console.error("ERROR: Still on login page after clicking Login.");
    return false;
  }

  console.log("Login successful. Now on:", page.url());
  return true;
}

// Navigate to a URL with full patience — waits for load, checks for login redirect, retries
async function navigateWithPatience(page, url, label = "") {
  const tag = label ? `[${label}]` : "";
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`${tag} Navigating to: ${url} (attempt ${attempt}/${MAX_RETRIES})`);

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
    } catch (err) {
      console.warn(`${tag} Navigation warning: ${err.message}`);
    }

    await waitForPageToSettle(page, label);

    // Check if we got redirected to login
    if (isLoginPage(page.url())) {
      console.log(`${tag} Redirected to login page.`);
      const loggedIn = await handleLoginIfNeeded(page);
      if (!loggedIn) {
        console.error(`${tag} Login failed on attempt ${attempt}.`);
        if (attempt === MAX_RETRIES) throw new Error("Could not log in after multiple attempts.");
        await sleep(5000);
        continue;
      }

      // After login, check if we landed on the target or need to re-navigate
      if (isPoliciesPage(page.url())) {
        console.log(`${tag} Already on policies page after login.`);
        return;
      }

      console.log(`${tag} Re-navigating to target after login...`);
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
      } catch (err) {
        console.warn(`${tag} Re-navigation warning: ${err.message}`);
      }
      await waitForPageToSettle(page, label);

      // If redirected to login AGAIN, retry the whole loop
      if (isLoginPage(page.url())) {
        console.warn(`${tag} Redirected to login again after re-navigation.`);
        if (attempt < MAX_RETRIES) {
          await sleep(5000);
          continue;
        }
      }
    }

    // Verify we're on the right page
    if (isPoliciesPage(page.url())) {
      console.log(`${tag} Successfully on policies page.`);
      return;
    }

    console.log(`${tag} Current URL: ${page.url()}`);
    return;
  }
}

// Start cloud profile via GoLogin REST API if not already running
async function ensureCloudProfileRunning(token, profileId) {
  const https = require("https");
  const http = require("http");

  const apiUrl = `https://api.gologin.com/browser/${profileId}/web`;

  return new Promise((resolve, reject) => {
    const req = https.request(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log("Cloud profile started via API.");
          resolve(true);
        } else if (res.statusCode === 409) {
          console.log("Cloud profile is already running.");
          resolve(true);
        } else if (res.statusCode === 504) {
          console.log("Cloud profile is still starting up (504 timeout). Will keep waiting...");
          resolve(true);
        } else {
          console.warn(`Start cloud profile API returned ${res.statusCode}: ${data.substring(0, 200)}`);
          resolve(false);
        }
      });
    });

    req.on("error", (err) => {
      console.warn("Failed to call start cloud profile API:", err.message);
      resolve(false);
    });

    req.end();
  });
}

// Stop cloud profile via GoLogin REST API (frees the cloud slot)
async function stopCloudProfile(token, profileId) {
  const https = require("https");

  const apiUrl = `https://api.gologin.com/browser/${profileId}/web`;

  return new Promise((resolve) => {
    const req = https.request(apiUrl, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log("Cloud profile stopped.");
        } else {
          console.warn(`Stop cloud profile API returned ${res.statusCode}: ${data.substring(0, 200)}`);
        }
        resolve();
      });
    });

    req.on("error", (err) => {
      console.warn("Failed to stop cloud profile:", err.message);
      resolve();
    });

    req.end();
  });
}

// ── Cloud mode: connect to GoLogin cloud browser (auto-starts if needed) ──
async function startCloudBrowser() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  if (!GOLOGIN_TOKEN || !GOLOGIN_PROFILE_ID) {
    throw new Error("GOLOGIN_TOKEN and GOLOGIN_PROFILE_ID must be set");
  }

  const GL = GologinApi({ token: GOLOGIN_TOKEN });

  // Stop any other running cloud profiles first to free the slot (Professional plan = 1 slot)
  const otherProfiles = Object.values(PROFILES)
    .map(p => p.profileId)
    .filter(id => id !== GOLOGIN_PROFILE_ID);

  for (const otherId of otherProfiles) {
    console.log(`Stopping other cloud profile ${otherId} (if running)...`);
    await stopCloudProfile(GOLOGIN_TOKEN, otherId);
  }

  // Start this cloud profile
  console.log("Ensuring cloud profile is running...");
  await ensureCloudProfileRunning(GOLOGIN_TOKEN, GOLOGIN_PROFILE_ID);

  // Wait for the cloud browser to be ready after starting
  console.log("Waiting for cloud browser to initialize (30s)...");
  await sleep(30000);

  console.log("Connecting to GoLogin cloud browser...");

  let browser = null;
  const MAX_CONNECT_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      const result = await GL.launch({
        profileId: GOLOGIN_PROFILE_ID,
        cloud: true,
      });
      browser = result.browser;
      break;
    } catch (err) {
      const is503 = String(err.message || err).includes("503");
      console.warn(`Connection attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed${is503 ? " (profile not ready yet)" : ""}: ${(err.message || "").substring(0, 100)}`);

      if (attempt < MAX_CONNECT_ATTEMPTS) {
        if (is503) {
          console.log("Retrying start and waiting for profile to come up (30s)...");
          await ensureCloudProfileRunning(GOLOGIN_TOKEN, GOLOGIN_PROFILE_ID);
          await sleep(30000);
        } else {
          await sleep(10000);
        }
      } else {
        throw new Error(`Failed to connect to cloud browser after ${MAX_CONNECT_ATTEMPTS} attempts.`);
      }
    }
  }

  console.log("Connected to cloud browser.");
  await sleep(5000);

  const pages = await browser.pages();
  console.log(`Found ${pages.length} tab(s).`);

  let page = null;
  for (const p of pages) {
    try {
      const url = p.url();
      console.log("  Tab:", url);
      if (isPoliciesPage(url)) {
        page = p;
        console.log("  ↳ Using this tab (policies page).");
      }
    } catch {}
  }

  if (!page) {
    page = pages[0] || (await browser.newPage());
    console.log("No policies tab found, navigating...");
    await navigateWithPatience(page, POLICIES_URL, "cloud");
  } else {
    // Even if we found it, wait for it to settle and check for login redirect
    await waitForPageToSettle(page, "cloud-restore");
    if (isLoginPage(page.url())) {
      await handleLoginIfNeeded(page);
      if (!isPoliciesPage(page.url())) {
        await navigateWithPatience(page, POLICIES_URL, "cloud");
      }
    }
  }

  // Wait for page to be fully interactive
  console.log("Waiting for policies page to be fully ready...");
  await page.waitForSelector("#agent", { timeout: 60000 });
  await sleep(3000);

  console.log('Setting Agent Numbers to "All"...');
  await page.evaluate(() => {
    const select = document.querySelector("#agent");
    if (!select) return;
    const allOption = Array.from(select.options || []).find(
      (o) => (o.textContent || "").trim() === "All"
    );
    if (!allOption) return;
    select.value = allOption.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  console.log("Waiting for table to reload after filter change...");
  await sleep(10000);

  // Intercept the download response via CDP Fetch domain
  const client = await page.target().createCDPSession();

  let downloadResolve;
  const downloadPromise = new Promise((resolve, reject) => {
    downloadResolve = resolve;
    setTimeout(() => reject(new Error("Download timeout (90s)")), 90000);
  });

  await client.send("Fetch.enable", {
    patterns: [{ requestStage: "Response" }],
  });

  client.on("Fetch.requestPaused", async (event) => {
    const { requestId, responseHeaders } = event;
    const headers = {};
    for (const h of responseHeaders || []) {
      headers[h.name.toLowerCase()] = h.value;
    }

    const isDownload =
      (headers["content-disposition"] || "").includes("attachment") ||
      (headers["content-type"] || "").includes("spreadsheet") ||
      (headers["content-type"] || "").includes("excel") ||
      (headers["content-type"] || "").includes("octet-stream");

    if (isDownload) {
      console.log("Intercepted download response!");
      try {
        const { body, base64Encoded } = await client.send("Fetch.getResponseBody", { requestId });
        const buffer = base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body);
        downloadResolve(buffer);
      } catch (err) {
        console.warn("Failed to get response body:", err.message);
      }
    }

    try {
      await client.send("Fetch.continueRequest", { requestId });
    } catch {}
  });

  console.log('Clicking "Download Excel"...');
  const downloadBtnSelector = "button.download-btn";
  await page.waitForSelector(downloadBtnSelector, { timeout: 60000 });
  await sleep(2000);
  await page.click(downloadBtnSelector);

  console.log("Waiting for download response...");
  const fileBuffer = await downloadPromise;

  await client.send("Fetch.disable").catch(() => {});

  const filePath = path.join(DOWNLOAD_DIR, POLICY_BASENAME);
  fs.writeFileSync(filePath, fileBuffer);
  console.log(`Saved: ${filePath} (${fileBuffer.length} bytes)`);

  // Disconnect and stop the cloud profile to free the slot for next run
  console.log("Disconnecting from cloud browser...");
  browser.disconnect();

  console.log("Stopping cloud profile to free the slot...");
  await stopCloudProfile(GOLOGIN_TOKEN, GOLOGIN_PROFILE_ID);

  console.log("Done.");
  process.exit(0);
}

// Check if a URL or error indicates proxy failure
function isProxyError(urlOrError) {
  const s = String(urlOrError).toLowerCase();
  return s.includes("err_invalid_auth_credentials") ||
    s.includes("err_proxy_connection_failed") ||
    s.includes("err_tunnel_connection_failed") ||
    s.includes("err_too_many_retries") ||
    s.includes("chrome-error://chromewebdata");
}

// ── Local mode: launch local Chrome via GoLogin profile ──
async function startLocalBrowser() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  if (!GOLOGIN_TOKEN || !GOLOGIN_PROFILE_ID) {
    throw new Error("GOLOGIN_TOKEN and GOLOGIN_PROFILE_ID must be set");
  }

  const launchOptions = { profileId: GOLOGIN_PROFILE_ID };

  if (SKIP_PROXY_CHECK) {
    launchOptions.timezone = {
      timezone: "America/New_York",
      country: "US",
      city: "",
      ll: [0, 0],
      accuracy: 0,
    };
  }

  const proxyAuth = { username: PROXY_USER, password: PROXY_PASS };
  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n========== ATTEMPT ${attempt}/${MAX_ATTEMPTS} ==========`);

    // ── 1. Launch browser ──
    console.log("Launching GoLogin profile locally...");
    let browser = null;
    let GL = null;

    GL = GologinApi({
      token: GOLOGIN_TOKEN,
      profile_id: GOLOGIN_PROFILE_ID,
      uploadCookiesToServer: true,
      writeCookiesFromServer: true,
    });

    try {
      const result = await GL.launch(launchOptions);
      browser = result.browser;
    } catch (err) {
      console.error(`Launch failed: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(5000);
      continue;
    }

    console.log("Waiting for browser to fully start...");
    await sleep(8000);

    // ── 2. Verify proxy by loading a test page ──
    console.log("Verifying proxy is working...");
    let proxyOK = false;
    try {
      const allPages = await browser.pages();
      const testPage = allPages[0] || await browser.newPage();
      await testPage.authenticate(proxyAuth);
      await testPage.goto("https://ipinfo.io/ip", { waitUntil: "networkidle2", timeout: 30000 });
      await sleep(2000);
      const currentUrl = testPage.url();
      if (isProxyError(currentUrl)) {
        console.warn("Proxy check landed on error page:", currentUrl);
      } else {
        const ip = await testPage.evaluate(() => document.body.innerText.trim()).catch(() => "");
        if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          console.log(`Proxy verified! IP: ${ip}`);
          proxyOK = true;
        } else {
          console.warn("Proxy check returned unexpected content:", ip.substring(0, 100));
        }
      }
    } catch (err) {
      console.warn("Proxy verification failed:", err.message);
    }

    if (!proxyOK) {
      console.warn(`Proxy not working on attempt ${attempt}. Closing browser and retrying...`);
      try { await browser.close(); } catch {}
      if (attempt < MAX_ATTEMPTS) await sleep(5000);
      continue;
    }

    // ── 3. Set up proxy auth on all pages ──
    const pages = await browser.pages();
    console.log(`Found ${pages.length} tab(s).`);

    for (const p of pages) {
      try { await p.authenticate(proxyAuth); } catch {}
    }

    browser.on("targetcreated", async (target) => {
      if (target.type() === "page") {
        try {
          const p = await target.page();
          if (p) await p.authenticate(proxyAuth);
        } catch {}
      }
    });

    // ── 4. Find or navigate to the policies page ──
    let page = null;
    let alreadyOnPolicies = false;
    for (const p of pages) {
      try {
        const url = p.url();
        console.log("  Tab:", url);
        if (isPoliciesPage(url)) {
          page = p;
          alreadyOnPolicies = true;
          console.log("  ↳ Found policies tab.");
        }
      } catch {}
    }

    if (!page) {
      page = pages[0] || await browser.newPage();
      await page.authenticate(proxyAuth);
      console.log("No policies tab found, will navigate there.");
    }

    await page.setViewport({ width: 1366, height: 768 });

    // Close all other tabs
    for (const p of pages) {
      if (p !== page) {
        try { await p.close(); } catch {}
      }
    }

    // ── 5. Navigate to policies page ──
    let navigationFailed = false;

    if (alreadyOnPolicies) {
      console.log("Policies tab found, waiting for it to fully load...");
      await waitForPageToSettle(page, "restore");

      if (isProxyError(page.url())) {
        console.warn("Proxy error after restore. Will relaunch.");
        navigationFailed = true;
      } else if (isLoginPage(page.url())) {
        console.log("Policies tab redirected to login after restore.");
        const loggedIn = await handleLoginIfNeeded(page);
        if (loggedIn && !isPoliciesPage(page.url())) {
          await navigateWithPatience(page, POLICIES_URL, "post-login");
        }
      } else if (!isPoliciesPage(page.url())) {
        console.log("Policies tab URL changed, re-navigating...");
        await navigateWithPatience(page, POLICIES_URL, "re-nav");
      } else {
        console.log("Already on policies page, ready to proceed.");
      }
    } else {
      try {
        await navigateWithPatience(page, POLICIES_URL, "navigate");
      } catch (err) {
        console.warn("Navigation failed:", err.message);
      }
    }

    // Check if we hit a proxy error during navigation
    if (!navigationFailed && isProxyError(page.url())) {
      navigationFailed = true;
    }

    if (navigationFailed) {
      console.warn(`Proxy failed during navigation on attempt ${attempt}. Closing and retrying...`);
      try { await browser.close(); } catch {}
      if (attempt < MAX_ATTEMPTS) await sleep(5000);
      continue;
    }

    // Final check
    if (!isPoliciesPage(page.url())) {
      console.log("Not on policies page yet, trying direct navigation...");
      await navigateWithPatience(page, POLICIES_URL, "final");

      if (isProxyError(page.url())) {
        console.warn(`Proxy failed on final navigation, attempt ${attempt}. Closing and retrying...`);
        try { await browser.close(); } catch {}
        if (attempt < MAX_ATTEMPTS) await sleep(5000);
        continue;
      }
    }

    // ── 6. We're on the policies page — do the work ──
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: DOWNLOAD_DIR,
    });

    console.log("Waiting for policies page to be fully ready...");
    await page.waitForSelector("#agent", { timeout: 60000 });
    await sleep(3000);

    console.log('Setting Agent Numbers to "All"...');
    await page.evaluate(() => {
      const select = document.querySelector("#agent");
      if (!select) return;
      const allOption = Array.from(select.options || []).find(
        (o) => (o.textContent || "").trim() === "All"
      );
      if (!allOption) return;
      select.value = allOption.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    console.log("Waiting for table to reload after filter change...");
    await sleep(10000);

    console.log('Clicking "Download Excel"...');
    const downloadBtnSelector = "button.download-btn";
    await page.waitForSelector(downloadBtnSelector, { timeout: 60000 });
    await sleep(2000);
    await page.click(downloadBtnSelector);

    console.log("Waiting for download to complete...");
    await sleep(20000);

    // Rename downloaded file
    try {
      const original = path.join(DOWNLOAD_DIR, "policySummary.xlsx");
      const target = path.join(DOWNLOAD_DIR, POLICY_BASENAME);
      if (fs.existsSync(original)) {
        try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {}
        fs.renameSync(original, target);
        console.log(`Renamed policy file to: ${POLICY_BASENAME}`);
      } else {
        console.warn("policySummary.xlsx not found; checking for other .xlsx files...");
        const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith(".xlsx") && f !== POLICY_BASENAME);
        if (files.length > 0) {
          const newest = files.sort((a, b) =>
            fs.statSync(path.join(DOWNLOAD_DIR, b)).mtimeMs - fs.statSync(path.join(DOWNLOAD_DIR, a)).mtimeMs
          )[0];
          const src = path.join(DOWNLOAD_DIR, newest);
          try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {}
          fs.renameSync(src, target);
          console.log(`Renamed ${newest} → ${POLICY_BASENAME}`);
        } else {
          console.warn("No .xlsx file found in download directory.");
        }
      }
    } catch (err) {
      console.warn("Failed to rename policy file:", err.message);
    }

    // Save session back to GoLogin profile (syncs cookies/session to S3)
    console.log("Saving session to GoLogin profile...");
    try {
      await browser.close();
      await GL.exit();
      console.log("Session saved successfully.");
    } catch (err) {
      console.warn("Session save warning:", err.message);
      try { await browser.close(); } catch {}
    }
    console.log("Done. Excel file should be in:", DOWNLOAD_DIR);
    process.exit(0);
  }

  // If we exhausted all attempts
  console.error(`All ${MAX_ATTEMPTS} attempts failed. Aborting.`);
  process.exit(1);
}

// Entry point
if (useCloud) {
  startCloudBrowser().catch(console.error);
} else {
  startLocalBrowser().catch(console.error);
}
