const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

async function scrapeInstagram(username) {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-animations',
      '--no-zygote'
    ]
  });
  const page = await browser.newPage();

  // Set a realistic User-Agent to avoid immediate blocking
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  const networkLogs = [];

  // Enable request interception to capture API responses
  page.on('response', async (response) => {
    const request = response.request();
    // We care about XHR/Fetch for data
    if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
      try {
        const url = response.url();
        // Filter for GraphQL or internal API endpoints
        if (url.includes('graphql') || url.includes('/api/v1/')) {
          const contentType = response.headers()['content-type'];
          if (contentType && contentType.includes('application/json')) {
            const json = await response.json().catch(() => null);
            if (json) {
              networkLogs.push({ url, data: json });
            }
          }
        }
      } catch (err) {
        // ignore errors reading response body (e.g. redirects)
      }
    }
  });

  try {
    const url = `https://www.instagram.com/${username}/`;
    console.log(`Navigating to ${url}...`);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait a bit for any lazy requests and scroll down a bit to trigger more loading
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise(r => setTimeout(r, 5000));

    // Create debug file if needed locally, but comment out for prod to save space
    // fs.writeFileSync('debug_network.json', JSON.stringify(networkLogs, null, 2));

    // Check if login is required or page not found
    const privateAccount = await page.$('h2');

    // --- DATA EXTRACTION FROM NETWORK LOGS ---
    let posts = [];

    // Helper to find key in deep object
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

    // Look for "edge_owner_to_timeline_media" in any captured JSON
    for (const log of networkLogs) {
      const jsonString = JSON.stringify(log.data);
      if (jsonString.includes('edge_owner_to_timeline_media')) {
        const edges = findEdges(log.data);
        if (edges.length > 0) {
          edges.forEach(edge => {
            const node = edge.node;
            if (node) {
              // Extract basic info
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

              // Media Extraction Logic
              if (node.is_video && node.video_url) {
                post.isVideo = true;
                post.videoUrl = node.video_url;
                post.videoViewCount = node.video_view_count;
                post.displayUrl = node.display_url; // Thumbnail
              } else {
                post.isVideo = false;
                post.displayUrl = node.display_url;
              }

              // Sidecar (Carousel) Handling
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
                // Collect all image URLs for convenience
                post.images = post.children.map(c => c.displayUrl);
              }

              posts.push(post);
            }
          });
        }
      }
    }

    // Deduplicate posts
    posts = posts.filter((v, i, a) => a.findIndex(v2 => (v2.shortcode === v.shortcode)) === i);

    if (posts.length > 0) {
      console.log(`Extracted ${posts.length} posts from network logs.`);
      return posts;
    }

    // --- DOM FALLBACK ---
    console.log('Network extraction failed/empty. Trying DOM fallback...');
    await page.waitForSelector('article img', { timeout: 5000 }).catch(() => console.log('No posts found or timeout wait for images'));

    const domPosts = await page.evaluate(() => {
      const postElements = document.querySelectorAll('article a'); // Links to posts
      const data = [];

      postElements.forEach(post => {
        const link = post.href;
        const img = post.querySelector('img');
        const src = img ? img.src : null;
        const alt = img ? img.alt : null;

        if (link && src) {
          data.push({
            link,
            imageUrl: src,
            caption: alt
          });
        }
      });
      return data;
    });

    return domPosts;

  } catch (error) {
    console.error(`Error scraping ${username}: ${error.message}`);
    throw new Error(`Failed to scrape ${username}: ${error.message}`);
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeInstagram };
