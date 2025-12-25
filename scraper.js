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

  // 1. SET THE COOKIE (The Key Fix)
  // This injects your login session so Instagram thinks you are a real user.
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

  // Set User-Agent
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 800 });

  const networkLogs = [];

  page.on("response", async (response) => {
    const request = response.request();
    if (
      request.resourceType() === "xhr" ||
      request.resourceType() === "fetch"
    ) {
      try {
        const url = response.url();
        if (url.includes("graphql") || url.includes("/api/v1/")) {
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

    // Scroll
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise((r) => setTimeout(r, 5000));

    // --- NETWORK EXTRACTION ---
    let posts = [];

    function findEdges(obj) {
      if (!obj || typeof obj !== "object") return [];
      if (
        obj.edges &&
        Array.isArray(obj.edges) &&
        obj.edges.length > 0 &&
        obj.edges[0].node
      ) {
        return obj.edges;
      }
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const res = findEdges(obj[key]);
          if (res.length > 0) return res;
        }
      }
      return [];
    }

    for (const log of networkLogs) {
      const edges = findEdges(log.data);
      if (edges.length > 0) {
        edges.forEach((edge) => {
          const node = edge.node;
          if (node) {
            const post = {
              id: node.id,
              shortcode: node.shortcode,
              link: `https://www.instagram.com/p/${node.shortcode}/`,
              type: node.__typename,
              caption:
                node.edge_media_to_caption &&
                node.edge_media_to_caption.edges.length > 0
                  ? node.edge_media_to_caption.edges[0].node.text
                  : "",
              commentsCount: node.edge_media_to_comment?.count || 0,
              likesCount: node.edge_media_preview_like?.count || 0,
              timestamp: node.taken_at_timestamp,
              ownerId: node.owner ? node.owner.id : null,
              isVideo: node.is_video,
              displayUrl: node.display_url,
            };

            if (node.is_video && node.video_url) {
              post.videoUrl = node.video_url;
              post.videoViewCount = node.video_view_count;
            }

            if (
              node.edge_sidecar_to_children &&
              node.edge_sidecar_to_children.edges
            ) {
              post.isSidecar = true;
              post.children = node.edge_sidecar_to_children.edges.map(
                (childEdge) => ({
                  id: childEdge.node.id,
                  displayUrl: childEdge.node.display_url,
                  isVideo: childEdge.node.is_video,
                  videoUrl: childEdge.node.video_url,
                })
              );
              post.images = post.children.map((c) => c.displayUrl);
            }
            posts.push(post);
          }
        });
      }
    }

    posts = posts.filter(
      (v, i, a) => a.findIndex((v2) => v2.shortcode === v.shortcode) === i
    );

    if (posts.length > 0) {
      console.log(`Extracted ${posts.length} posts from network logs.`);
      return posts;
    }

    // --- DOM FALLBACK ---
    console.log("Network empty. Trying DOM fallback...");
    await page
      .waitForSelector("article img", { timeout: 5000 })
      .catch(() => console.log("Timeout waiting for images"));

    const domPosts = await page.evaluate(() => {
      const postElements = document.querySelectorAll("article a");
      const data = [];
      postElements.forEach((post) => {
        const link = post.href;
        const img = post.querySelector("img");
        if (link && img) {
          data.push({
            link,
            imageUrl: img.src,
            caption: img.alt,
          });
        }
      });
      return data;
    });

    if (domPosts.length > 0) {
      return domPosts;
    }

    // --- DEBUG RETURN ---
    const pageTitle = await page.title();
    const content = await page.content();
    const isLogin = content.includes("Login") || content.includes("Log In");

    return {
      _debug_error: true,
      message: "Scraping Blocked. Did you set INSTAGRAM_SESSION_ID correctly?",
      pageTitle: pageTitle,
      isLogin: isLogin,
    };
  } catch (error) {
    console.error(`Error scraping ${username}: ${error.message}`);
    throw new Error(`Failed to scrape ${username}: ${error.message}`);
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInstagram };
