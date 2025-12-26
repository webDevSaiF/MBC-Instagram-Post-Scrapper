"use strict";

const express = require("express");
const { scrapeInstagram } = require("./scraper");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // Simple env var for security

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ success: true, status: "Instagram Scraper API is running" });
});

app.get("/api/scrape/:username", async (req, res) => {
  try {
    // Simple Security: If API_KEY is set in env, require it in headers
    // If NOT set (local dev), skip check.
    if (API_KEY) {
      const authHeader = req.headers["authorization"];
      if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
        return res.status(401).json({ error: "Unauthorized: Invalid or missing API Key" });
      }
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
