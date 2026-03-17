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

// Profile configs: pass --profile=<key> to select which agency to run
const PROFILES = {
  heritage: {
    profileId: "69a9c9ff08c290038c0862e2",
    filename: "heritage_aetna_policy.xlsx",
  },
  unlimited: {
    profileId: "69b45ace32bf58680eaf59b1",
    filename: "unlimited_aetna_policy.xlsx",
  },
};

// Parse --profile=<key> from CLI args, default to "heritage"
const profileArg = (process.argv.find((a) => a.startsWith("--profile=")) || "").split("=")[1] || "heritage";
const profileConfig = PROFILES[profileArg];
if (!profileConfig) {
  console.error(`Unknown profile "${profileArg}". Available: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}

console.log(`Using profile: ${profileArg} (${profileConfig.profileId}) → ${profileConfig.filename}`);

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

async function waitForLoginAndClick(page) {
  let loginInput = null;
  try {
    loginInput = await page.waitForSelector("#aetnaUserName", { timeout: 15000 });
  } catch {
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
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

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

  // Wait for restored tabs to settle
  await sleep(5000);

  const pages = await browser.pages();
  console.log(`Found ${pages.length} restored tab(s).`);

  // Authenticate proxy on all existing pages
  for (const p of pages) {
    try {
      await p.authenticate(proxyAuth);
    } catch {}
  }

  browser.on("targetcreated", async (target) => {
    if (target.type() === "page") {
      try {
        const p = await target.page();
        if (p) await p.authenticate(proxyAuth);
      } catch {}
    }
  });

  // Try to find the policies tab among restored tabs
  let page = null;
  let alreadyOnPolicies = false;
  for (const p of pages) {
    const url = p.url();
    if (url.includes("ssibrokerwebaz/agent/policy/summary")) {
      page = p;
      alreadyOnPolicies = true;
      console.log("Found policies tab:", url);
      break;
    }
  }

  // If no policies tab, use the first available tab and navigate there
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

  // Only navigate if we're NOT already on the policies page
  if (!alreadyOnPolicies) {
    // Print proxy info by hitting ipinfo
    console.log("Checking proxy IP...");
    try {
      await page.goto("https://ipinfo.io/ip", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const ip = await page.evaluate(() => document.body.innerText.trim()).catch(() => "");
      console.log("Proxy IP (from GoLogin profile):", ip);
    } catch (err) {
      console.warn("Could not check proxy IP:", err.message);
    }

    // Navigate to carrier home (may redirect to login)
    console.log("Opening carrier home:", CARRIER_LOGIN_URL);
    await page.goto("about:blank");
    try {
      await page.goto(CARRIER_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
    } catch (err) {
      console.warn("Non-fatal navigation error:", err.message);
    }

    // Handle login if redirected
    await sleep(5000);
    await waitForLoginAndClick(page);

    // Navigate to policies page
    console.log("Opening policies page:", POLICIES_URL);
    try {
      await page.goto(POLICIES_URL, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
    } catch (err) {
      console.warn("Non-fatal navigation error:", err.message);
    }

    // Handle login again if policies page redirected
    await sleep(5000);
    const loggedInAgain = await waitForLoginAndClick(page);

    if (loggedInAgain) {
      console.log("Re-navigating to policies page after login...");
      try {
        await page.goto(POLICIES_URL, {
          waitUntil: "domcontentloaded",
          timeout: 120000,
        });
      } catch (err) {
        console.warn("Non-fatal navigation error:", err.message);
      }
      await sleep(5000);
    }
  } else {
    console.log("Already on policies page, skipping navigation.");
  }

  // Set download directory
  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });

  // Set Agent Numbers to "All"
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

  // Click Download Excel
  console.log('Clicking "Download Excel"...');
  const downloadBtnSelector = "button.download-btn";
  await page.waitForSelector(downloadBtnSelector, { timeout: 60000 });
  await page.click(downloadBtnSelector);

  console.log("Waiting for download to complete...");
  await sleep(15000);

  // Rename downloaded file
  try {
    const original = path.join(DOWNLOAD_DIR, "policySummary.xlsx");
    const target = path.join(DOWNLOAD_DIR, POLICY_BASENAME);
    if (fs.existsSync(original)) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {}
      fs.renameSync(original, target);
      console.log(`Renamed policy file to: ${POLICY_BASENAME}`);
    } else {
      console.warn("policySummary.xlsx not found; skipping rename.");
    }
  } catch (err) {
    console.warn("Failed to rename policy file:", err.message);
  }

  // Save session
  console.log("Saving session to GoLogin profile...");
  try {
    await browser.close();
    await GL.exit();
  } catch {}
  console.log("Session saved. Excel file should be in:", DOWNLOAD_DIR);
  process.exit(0);
}

startBrowser().catch(console.error);
