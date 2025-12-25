"use strict";

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");

puppeteer.use(StealthPlugin());

async function scrapeInstagram(username) {
  let browser;
  let page;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,800"
      ]
    });

    page = await browser.newPage();

    // Realistic UA (important)
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.setViewport({ width: 1280, height: 800 });

    const networkLogs = [];

    // Capture JSON responses
    page.on("response", async (response) => {
      try {
        const req = response.request();
        const url = response.url();

        if (
          (req.resourceType() === "xhr" ||
            req.resourceType() === "fetch") &&
          (url.includes("graphql") || url.includes("/api/v1/"))
        ) {
          const ct = response.headers()["content-type"];
          if (ct && ct.includes("application/json")) {
            const json = await response.json().catch(() => null);
            if (json) {
              networkLogs.push(json);
            }
          }
        }
      } catch {
        // ignore
      }
    });

    const profileUrl = `https://www.instagram.com/${username}/`;
    console.log(`🌐 Navigating to ${profileUrl}`);

    await page.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Small human-like delay
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(4000);

    // DEBUG (optional — remove later)
    fs.writeFileSync(
      "debug_network.json",
      JSON.stringify(networkLogs, null, 2)
    );

    const html = await page.content();
    fs.writeFileSync("debug.html", html);

    //
