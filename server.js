"use strict";

const express = require("express");
const { scrapeInstagram } = require("./scraper");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Token cache
let cachedToken = null;
let cachedTokenFetchedAt = 0;
const TOKEN_CACHE_MS = 60 * 1000;

app.get("/", (req, res) => {
  res.json({ success: true, status: "Server is running" });
});

app.get("/api/scrape/:username", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
      return res.status(401).json({ error: "Access Token Missing" });
    }

    const token = extractBearer(authHeader);
    if (!token) {
      return res.status(401).json({ error: "Invalid Token Format" });
    }

    // Disable token check for local testing if needed, currently enabled
    const allowedToken = await validateToken();
    if (!allowedToken || token !== allowedToken) {
      return res.status(401).json({ error: "Invalid Authorization Token" });
    }

    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    console.log(`Starting scrape for: ${username}`);
    const data = await scrapeInstagram(username);

    // CHECK FOR DEBUG ERROR FROM SCRAPER
    if (data._debug_error) {
      return res.status(422).json({
        success: false,
        error: "Scraping Blocked",
        details: data,
      });
    }

    return res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("Scraping failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Scraping failed",
    });
  }
});

// Helpers
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
  if (cachedToken && now - cachedTokenFetchedAt < TOKEN_CACHE_MS) {
    return cachedToken;
  }
  const url = process.env.MBC_SHEET_DATABASE;
  if (!url) return null;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const result = await response.json();
    const token = result?.data?.["Bot Database"]?.[0]?.["access_token"];
    if (token) {
      cachedToken = token;
      cachedTokenFetchedAt = now;
    }
    return token;
  } catch (err) {
    return null;
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
