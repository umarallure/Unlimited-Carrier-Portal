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

const GOLOGIN_TOKEN = env("GOLOGIN_TOKEN");
const GOLOGIN_PROFILE_ID = env("GOLOGIN_PROFILE_ID") || env("GOLOGIN_PROFILEID");

const SKIP_PROXY_CHECK = env("GOLOGIN_SKIP_PROXY_CHECK", "0") === "1";
const MANUAL_NAVIGATE = env("CARRIER_MANUAL_NAVIGATE", "0") === "1";

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

async function waitForLoginAndClick(page) {
  console.log("Waiting for possible login redirect...");

  let loginInput = null;
  try {
    loginInput = await page.waitForSelector("#aetnaUserName", { timeout: 15000 });
  } catch {
    console.log("No login page appeared, continuing.");
    return false;
  }

  if (!loginInput) return false;

  console.log("Login page detected, waiting for creds to autofill...");
  await sleep(3000);

  const loginBtnSelector = 'button[name="Login"][type="submit"]';
  await page.waitForSelector(loginBtnSelector, { timeout: 10000 });

  console.log("Clicking Login button...");
  await page.click(loginBtnSelector);

  await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    sleep(15000),
  ]);

  const stillOnLogin = await page.$("#aetnaUserName").catch(() => null);
  if (stillOnLogin) {
    console.error("ERROR: Still on login page after clicking Login.");
    return false;
  }

  console.log("Login successful.");
  return true;
}

async function startBrowser() {
  await ensureDownloadDir();

  if (!GOLOGIN_TOKEN || !GOLOGIN_PROFILE_ID) {
    throw new Error("GOLOGIN_TOKEN and GOLOGIN_PROFILE_ID must be set");
  }

  const GL = GologinApi({
    token: GOLOGIN_TOKEN,
    profile_id: GOLOGIN_PROFILE_ID,
    uploadCookiesToServer: true,
    writeCookiesFromServer: true,
  });

  const launchOptions = {
    profileId: GOLOGIN_PROFILE_ID,
  };

  if (SKIP_PROXY_CHECK) {
    launchOptions.timezone = {
      timezone: "America/New_York",
      country: "US",
      city: "",
      ll: [0, 0],
      accuracy: 0,
    };
  }

  console.log("Launching GoLogin profile...");

  const { browser } = await GL.launch(launchOptions);

  const proxyAuth = {
    username: PROXY_USER,
    password: PROXY_PASS,
  };

  const page = await browser.newPage();

  await page.authenticate(proxyAuth);

  browser.on("targetcreated", async (target) => {
    if (target.type() === "page") {
      try {
        const p = await target.page();
        if (p) await p.authenticate(proxyAuth);
      } catch {}
    }
  });

  await page.setViewport({ width: 1366, height: 768 });

  console.log("Warming proxy connection...");

  try {
    await page.goto("https://ipinfo.io/ip", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const ip = await page.evaluate(() => document.body.innerText.trim()).catch(() => "");
    console.log("Proxy warmed. External IP:", ip);
  } catch {}

  // --- Step 1: Navigate to carrier home (triggers login redirect) ---

  if (MANUAL_NAVIGATE) {
    console.log("Browser opened.");
    console.log("Open this URL manually:", CARRIER_LOGIN_URL);
  } else {
    console.log("Opening carrier login:", CARRIER_LOGIN_URL);

    await page.goto("about:blank");

    await page.goto(CARRIER_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
  }

  // Wait for JS redirect to login page, then click Login
  await sleep(5000);
  await waitForLoginAndClick(page);

  // --- Step 2: Navigate to policies page ---

  console.log("Opening policies page:", POLICIES_URL);

  try {
    await page.goto(POLICIES_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
  } catch (err) {
    console.warn("Non-fatal navigation error on POLICIES_URL:", err.message);
  }

  // Policies page may also redirect to login
  await sleep(5000);
  const loggedInAgain = await waitForLoginAndClick(page);

  // If we had to login again, re-navigate to policies
  if (loggedInAgain) {
    console.log("Re-navigating to policies page after login...");
    try {
      await page.goto(POLICIES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
    } catch (err) {
      console.warn("Non-fatal navigation error on POLICIES_URL:", err.message);
    }
    await sleep(5000);
  }

  // --- Step 3: Set download directory ---

  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });

  // --- Step 4: Set Agent Numbers to "All" ---

  console.log('Setting Agent Numbers to "All"...');
  await page.waitForSelector("#agent", { timeout: 60000 });
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

  await sleep(5000);

  // --- Step 5: Click Download Excel ---

  console.log('Clicking "Download Excel"...');
  const downloadBtnSelector = "button.download-btn";
  await page.waitForSelector(downloadBtnSelector, { timeout: 60000 });
  await page.click(downloadBtnSelector);

  console.log("Waiting for download to complete...");
  await sleep(15000);

  // --- Done: close without saving session ---

  try {
    await browser.close();
  } catch {}
  console.log("Done. Excel file should be in:", DOWNLOAD_DIR);
  process.exit(0);
}

startBrowser().catch(console.error);
