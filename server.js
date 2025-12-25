const express = require("express");
const { scrapeInstagram } = require("./scraper");
const app = express();
const PORT = process.env.PORT || 3000;
let cachedToken = null;
let cachedTokenFetchedAt = 0;
const TOKEN_CACHE_MS = 60 * 1000;
app.use(express.json());

app.get("/api/scrape/:username", async (req, res) => {
  try {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];
    if (!authHeader) {
      return res
        .status(401)
        .set(
          "WWW-Authenticate",
          'Bearer realm="Access to the resource", error="invalid_token"'
        )
        .json({ error: "unauthorized", message: "Access Token Missing" });
    }
    const token = extractBearer(authHeader);
    console.log(token);
    if (!token) {
      return res
        .status(401)
        .set(
          "WWW-Authenticate",
          'Bearer realm="Access to the resource", error="invalid_token"'
        )
        .json({
          error: "unauthorized",
          message:
            "Invalid Authorization header. Use: Authorization: Bearer <token>",
        });
    }
    const allowedToken = await validateToken();
    if (!allowedToken || token !== allowedToken) {
      return res
        .status(401)
        .set(
          "WWW-Authenticate",
          'Bearer realm="Access to the resource", error="invalid_token"'
        )
        .json({
          error: "unauthorized",
          message: "Invalid or missing authorization token.",
        });
    }
  } catch (authErr) {
    console.error("Auth error:", authErr);
    return res.status(500).json({
      error: "auth_error",
      message: "Error while validating authorization token.",
    });
  }
  const { username } = req.params;
  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  try {
    console.log(`Starting scrape for user: ${username}`);
    const data = await scrapeInstagram(username);
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Scraping failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ---------- AUTH HELPERS ----------

function extractBearer(headerValue) {
  const token = headerValue
    .replace(/bearer/gi, "")
    .replace(/[\s:]+/g, " ")
    .trim();
  return token || null;
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
  console.log(url);
  if (!url) {
    console.error("MBC_SHEET_DATABASE env var is not set");
    return null;
  }

  const requestOptions = {
    method: "GET",
    redirect: "follow",
  };

  try {
    const response = await fetch(url, requestOptions);
    if (!response.ok) {
      console.error("Token DB request failed with status:", response.status);
      return null;
    }

    const result = await response.json();
    // Adjust this path if your sheet JSON shape is different
    const data = result.data["Bot Database"][0]["access_token"];

    cachedToken = data;
    cachedTokenFetchedAt = now;

    return data;
  } catch (error) {
    console.error("Error fetching token DB:", error);
    return null;
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
