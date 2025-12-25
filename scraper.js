const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const fs = require("fs");

async function scrapeInstagram(username) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
    ],
  });
  const page = await browser.newPage();

  // 1. SET THE COOKIE
  if (process.env.INSTAGRAM_SESSION_ID) {
    await page.setCookie({
      name: "sessionid",
      value: process.env.INSTAGRAM_SESSION_ID,
      domain: ".instagram.com",
      path: "/",
      httpOnly: true,
      secure: true,
    });
    console.log("✅ Session ID cookie set.");
  } else {
    console.warn(
      "⚠️ No INSTAGRAM_SESSION_ID found. Scraping might be blocked."
    );
  }

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 800 });

  const networkLogs = [];

  // Capture Responses
  page.on("response", async (response) => {
    const request = response.request();
    if (["xhr", "fetch"].includes(request.resourceType())) {
      try {
        const url = response.url();
        // Capture everything that looks like data
        if (
          url.includes("graphql") ||
          url.includes("/api/v1/") ||
          url.includes("web_profile_info")
        ) {
          const contentType = response.headers()["content-type"];
          if (contentType && contentType.includes("application/json")) {
            const json = await response.json().catch(() => null);
            if (json) networkLogs.push({ url, data: json });
          }
        }
      } catch (err) {}
    }
  });

  try {
    const url = `https://www.instagram.com/${username}/`;
    console.log(`Navigating to ${url}...`);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // Scroll heavily to trigger the main feed
    await page.evaluate(async () => {
      window.scrollBy(0, 1000);
      await new Promise((r) => setTimeout(r, 1000));
      window.scrollBy(0, 2000);
    });
    await new Promise((r) => setTimeout(r, 3000));

    // --- SMART EXTRACTION ---
    let posts = [];

    // Helper: Safely extract post details regardless of structure version
    function parseNode(node) {
      // Ignore Highlights or undefined nodes
      if (!node || (node.id && node.id.includes("highlight"))) return null;

      // Handle "shortcode" vs "code" (API variance)
      const code = node.shortcode || node.code;
      if (!code) return null; // If no code, it's not a valid post link

      const post = {
        id: node.id,
        shortcode: code,
        link: `https://www.instagram.com/p/${code}/`,
        type: node.__typename || "Post",
        timestamp: node.taken_at_timestamp || node.taken_at,
        ownerId: node.owner ? node.owner.id : null,
        likesCount: 0,
        commentsCount: 0,
        caption: "",
      };

      // Likes
      if (node.edge_media_preview_like)
        post.likesCount = node.edge_media_preview_like.count;
      else if (node.like_count) post.likesCount = node.like_count;

      // Comments
      if (node.edge_media_to_comment)
        post.commentsCount = node.edge_media_to_comment.count;
      else if (node.comment_count) post.commentsCount = node.comment_count;

      // Caption
      if (node.edge_media_to_caption && node.edge_media_to_caption.edges?.[0]) {
        post.caption = node.edge_media_to_caption.edges[0].node.text;
      } else if (node.caption && node.caption.text) {
        post.caption = node.caption.text;
      }

      // Media
      post.isVideo = !!node.is_video;
      post.displayUrl =
        node.display_url || node.image_versions2?.candidates?.[0]?.url;

      return post;
    }

    // Look through all network logs
    for (const log of networkLogs) {
      const data = log.data;

      // Strategy 1: GraphQL "edges" (Standard Web)
      // We look specifically for 'edge_owner_to_timeline_media' to avoid Highlights
      function findTimeline(obj) {
        if (!obj || typeof obj !== "object") return;
        if (
          obj.edge_owner_to_timeline_media &&
          obj.edge_owner_to_timeline_media.edges
        ) {
          obj.edge_owner_to_timeline_media.edges.forEach((edge) => {
            const parsed = parseNode(edge.node);
            if (parsed) posts.push(parsed);
          });
        }
        // Recursive search
        Object.values(obj).forEach((val) => findTimeline(val));
      }
      findTimeline(data);

      // Strategy 2: API v1 "items" (Mobile/Internal API)
      if (data.items && Array.isArray(data.items)) {
        data.items.forEach((item) => {
          const parsed = parseNode(item);
          if (parsed) posts.push(parsed);
        });
      }
    }

    // Deduplicate posts
    posts = posts.filter(
      (v, i, a) => a.findIndex((v2) => v2.shortcode === v.shortcode) === i
    );

    if (posts.length > 0) {
      console.log(`Extracted ${posts.length} posts from network logs.`);
      return posts;
    }

    // --- DOM FALLBACK (Last Resort) ---
    console.log("Network empty. Trying DOM fallback...");

    // Wait specifically for square images inside articles (typical post grid)
    await page
      .waitForSelector("article a[href^='/p/']", { timeout: 5000 })
      .catch(() => {});

    const domPosts = await page.evaluate(() => {
      const postElements = document.querySelectorAll("article a[href^='/p/']");
      const data = [];
      postElements.forEach((post) => {
        const link = post.getAttribute("href"); // e.g., "/p/Cxy123/"
        const img = post.querySelector("img");

        if (link && img) {
          const shortcode = link.split("/")[2];
          data.push({
            id: shortcode, // temporary ID
            shortcode: shortcode,
            link: `https://www.instagram.com${link}`,
            imageUrl: img.src,
            caption: img.alt || "",
            type: "DOM_Fallback",
          });
        }
      });
      return data;
    });

    if (domPosts.length > 0) return domPosts;

    return {
      _debug_error: true,
      message: "No posts found. Session might be invalid or profile empty.",
      pageTitle: await page.title(),
      isLogin: (await page.content()).includes("Login"),
    };
  } catch (error) {
    console.error(`Error scraping ${username}: ${error.message}`);
    throw new Error(`Failed to scrape ${username}: ${error.message}`);
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInstagram };
