const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

async function scrapeInstagram(username) {
  const launchOptions = {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-animations',
      '--no-zygote'
    ]
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  // --- 1. SET SESSION COOKIE IF PROVIDED ---
  if (process.env.INSTAGRAM_SESSION_ID) {
    await page.setCookie({
      name: "sessionid",
      value: process.env.INSTAGRAM_SESSION_ID,
      domain: ".instagram.com",
      path: "/",
      httpOnly: true,
      secure: true
    });
  }

  // --- MOBILE EMULATION (SSR STRATEGY) ---
  // Instagram often server-side renders the initial feed for mobile devices, which is easier to scrape than the Desktop SPA.
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const networkLogs = [];

  page.on('response', async (response) => {
    const request = response.request();
    if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
      try {
        const url = response.url();
        if (url.includes('graphql') || url.includes('/api/v1/')) {
          const contentType = response.headers()['content-type'];
          if (contentType && contentType.includes('application/json')) {
            const json = await response.json().catch(() => null);
            if (json) {
              networkLogs.push({ url, data: json });
            }
          }
        }
      } catch (err) { }
    }
  });

  try {
    const url = `https://www.instagram.com/${username}/`;
    console.log(`Navigating to ${url}...`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise(r => setTimeout(r, 2000));

    // --- DATA EXTRACTION ---
    let posts = [];
    function findEdges(obj) {
      if (!obj || typeof obj !== 'object') return [];
      if (obj.edges && Array.isArray(obj.edges) && obj.edges.length > 0 && obj.edges[0].node) {
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

    // Search Network Logs
    for (const log of networkLogs) {
      const jsonString = JSON.stringify(log.data);
      if (jsonString.includes('edge_owner_to_timeline_media')) {
        const edges = findEdges(log.data);
        if (edges.length > 0) {
          edges.forEach(edge => {
            const node = edge.node;
            if (node) {
              const post = {
                id: node.id,
                shortcode: node.shortcode,
                link: `https://www.instagram.com/p/${node.shortcode}/`,
                type: node.__typename,
                caption: node.edge_media_to_caption && node.edge_media_to_caption.edges.length > 0 ? node.edge_media_to_caption.edges[0].node.text : '',
                commentsCount: node.edge_media_to_comment ? node.edge_media_to_comment.count : 0,
                likesCount: node.edge_media_preview_like ? node.edge_media_preview_like.count : 0,
                timestamp: node.taken_at_timestamp,
                ownerId: node.owner ? node.owner.id : null
              };
              if (node.is_video && node.video_url) {
                post.isVideo = true;
                post.videoUrl = node.video_url;
                post.videoViewCount = node.video_view_count;
                post.displayUrl = node.display_url;
              } else {
                post.isVideo = false;
                post.displayUrl = node.display_url;
              }
              if (node.edge_sidecar_to_children && node.edge_sidecar_to_children.edges) {
                post.isSidecar = true;
                post.children = node.edge_sidecar_to_children.edges.map(childEdge => {
                  const child = childEdge.node;
                  return {
                    id: child.id,
                    type: child.__typename,
                    isVideo: child.is_video,
                    displayUrl: child.display_url,
                    videoUrl: child.is_video ? child.video_url : null,
                    accessibilityCaption: child.accessibility_caption
                  };
                });
                post.images = post.children.map(c => c.displayUrl);
              }
              posts.push(post);
            }
          });
        }
      }
    }

    posts = posts.filter((v, i, a) => a.findIndex(v2 => (v2.shortcode === v.shortcode)) === i);

    if (posts.length > 0) {
      console.log(`Extracted ${posts.length} posts from network logs.`);
      return posts;
    }

    // --- GENERIC DOM FALLBACK (AGGRESSIVE) ---
    console.log('Trying Aggressive DOM fallback...');

    await page.waitForSelector('a[href*="/p/"]', { timeout: 5000 }).catch(() => console.log('No post links found in DOM'));

    const domPosts = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      const data = [];
      const seenLinks = new Set();

      anchors.forEach(anchor => {
        const link = anchor.href;
        if (!link || seenLinks.has(link)) return;
        const img = anchor.querySelector('img') || anchor.parentElement.querySelector('img');
        if (img && img.src) {
          const shortcodeMatch = link.match(/\/p\/([^\/]+)\//);
          const shortcode = shortcodeMatch ? shortcodeMatch[1] : 'unknown';
          data.push({
            id: shortcode,
            shortcode: shortcode,
            link: link,
            type: 'GraphImage',
            displayUrl: img.src,
            caption: img.alt || '',
            timestamp: Date.now() / 1000
          });
          seenLinks.add(link);
        }
      });
      return data.slice(0, 12);
    });

    if (domPosts.length > 0) {
      console.log(`DOM Fallback found ${domPosts.length} posts.`);
      return domPosts;
    }

    // --- DIAGNOSTICS (HTML DUMP) ---
    console.log('Scrape failed. Dumping diagnostics...');
    const title = await page.title();

    // GET BODY CONTENT (More useful than HEAD)
    const bodyContent = await page.evaluate(() => document.body ? document.body.innerHTML : 'CHECK_HTML_SNIPPET');
    const fullContent = await page.content();

    // Prioritize showing the BODY if it exists
    const preview = bodyContent.length > 100 ? bodyContent : fullContent;

    return {
      _debug_error: true,
      message: "NO_POSTS_FOUND",
      possible_causes: [
        "Instagram Login Wall",
        "Profile is Private",
        "Render IP Blocked",
        "Mobile Layout Changed"
      ],
      debug_info: {
        page_title: title,
        network_requests: networkLogs.length,
        cookies_set: !!process.env.INSTAGRAM_SESSION_ID,
        html_preview: preview.substring(0, 2000)
      }
    };

  } catch (error) {
    console.error(`Error scraping ${username}: ${error.message}`);
    throw new Error(`Failed to scrape ${username}: ${error.message}`);
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInstagram };
