"use strict";

const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { scrapeInstagram } = require("./scraper");
require("dotenv").config();

// ─────────────────────────────────────
// Puppeteer setup
// ─────────────────────────────────────
puppeteer.use(StealthPlugin());

// Node < 18 safety (Render uses Node 18+, but safe anyway)
if (!global.fetch) {
  global.fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

// ─────────────────────────────────────
// App setup
// ─────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─────────────────────────────────────
// Token cache
// ─────────────────────────────────────
let cachedToken = null;
let cachedTokenFetchedAt = 0;
const TOKEN_CACHE_MS = 60 * 1000;

// ─────────────────────────────────────
// Health check (RENDER REQUIRED)
// ─────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ success: true, status: "Server is running" });
});

// ─────────────────────────────────────
// Scrape API
// ─────────────────────────────────────
app.get("/api/scrape/:username", async (req, res) => {
  try {
    // ─── Authorization ───
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];

    if (!authHeader) {
      return res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="Access", error="invalid_token"')
        .json({
          error: "unauthorized",
          message: "Access Token Missing",
        });
    }

    const token = extractBearer(authHeader);
    if (!token) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Use Authorization: Bearer <token>",
      });
    }

    const allowedToken = await validateToken();
    if (!allowedToken || token !== allowedToken) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Invalid authorization token",
      });
    }

    // ─── Username ───
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    console.log(`🚀 Starting scrape for: ${username}`);

    const data = await scrapeInstagram(username);

    return res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("❌ Scraping failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Scraping failed",
    });
  }
});

// ─────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────
function extractBearer(headerValue) {
  return (
    headerValue
      .replace(/bearer/gi, "")
      .replace(/[\s:]+/g, " ")
      .trim() || null
  );
}

async function validateToken() {
  const now = Date.now();

  if (
    cachedToken &&
    cachedTokenFetchedAt &&
    now - cachedTokenFetchedAt < TOKEN_CACHE_MS
  ) {
    return cachedToken;
  }

  const url = process.env.MBC_SHEET_DATABASE;
  if (!url) {
    console.error("❌ MBC_SHEET_DATABASE env var not set");
    return null;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error("❌ Token DB status:", response.status);
      return null;
    }

    const result = await response.json();
    const token = result?.data?.["Bot Database"]?.[0]?.["access_token"] || null;

    if (!token) {
      console.error("❌ Token not found in sheet");
      return null;
    }

    cachedToken = token;
    cachedTokenFetchedAt = now;
    return token;
  } catch (err) {
    console.error("❌ Token fetch error:", err);
    return null;
  }
}

// ─────────────────────────────────────
// Start server
// ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
