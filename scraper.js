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

    // Allow initial load
    await new Promise(r => setTimeout(r, 4000));

    // Scroll multiple times to trigger infinite scroll (Mobile View)
    console.log('Scrolling to load more posts...');
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 1500));
    }
    await new Promise(r => setTimeout(r, 2000)); // Final settle

    // --- DATA EXTRACTION (API FALLBACK) ---
    let posts = [];

    // Helper to normalize different API response structures
    function parsePost(node) {
      const post = {
        id: node.id || node.pk,
        shortcode: node.code || node.shortcode,
        link: `https://www.instagram.com/p/${node.code || node.shortcode}/`,
        type: 'GraphImage', // default
        caption: '',
        commentsCount: 0,
        likesCount: 0,
        timestamp: node.taken_at || node.taken_at_timestamp,
        ownerId: node.user ? (node.user.pk || node.user.id) : (node.owner ? node.owner.id : null)
      };

      // Extract Caption
      if (node.caption && node.caption.text) {
        post.caption = node.caption.text;
      } else if (node.edge_media_to_caption && node.edge_media_to_caption.edges.length > 0) {
        post.caption = node.edge_media_to_caption.edges[0].node.text;
      }

      // Extract Counts
      if (node.comment_count !== undefined) post.commentsCount = node.comment_count;
      else if (node.edge_media_to_comment) post.commentsCount = node.edge_media_to_comment.count;

      if (node.like_count !== undefined) post.likesCount = node.like_count;
      else if (node.edge_media_preview_like) post.likesCount = node.edge_media_preview_like.count;

      // Determine Type & Media
      const mediaType = node.media_type; // 1=Img, 2=Vid, 8=Sidecar
      const isVideo = node.is_video || mediaType === 2;
      const isSidecar = !!node.carousel_media || !!node.edge_sidecar_to_children || mediaType === 8;

      if (isVideo) {
        post.type = 'GraphVideo';
        post.isVideo = true;
        post.videoUrl = node.video_versions ? node.video_versions[0].url : node.video_url;
        post.videoViewCount = node.video_view_count || node.view_count;
        post.displayUrl = node.image_versions2 ? node.image_versions2.candidates[0].url : node.display_url;
      } else if (isSidecar) {
        post.type = 'GraphSidecar';
        post.isSidecar = true;
        post.displayUrl = node.image_versions2 ? node.image_versions2.candidates[0].url : node.display_url;

        // Extract Children
        const childrenNodes = node.carousel_media || (node.edge_sidecar_to_children ? node.edge_sidecar_to_children.edges.map(e => e.node) : []);
        post.children = childrenNodes.map(child => {
          return {
            id: child.id || child.pk,
            type: (child.media_type === 2 || child.is_video) ? 'GraphVideo' : 'GraphImage',
            displayUrl: child.image_versions2 ? child.image_versions2.candidates[0].url : child.display_url,
            videoUrl: (child.video_versions ? child.video_versions[0].url : child.video_url) || null
          };
        });
        post.images = post.children.map(c => c.displayUrl); // Flatten for convenience
      } else {
        post.type = 'GraphImage';
        post.isVideo = false;
        post.displayUrl = node.image_versions2 ? node.image_versions2.candidates[0].url : node.display_url;
      }

      return post;
    }

    // Search Network Logs
    for (const log of networkLogs) {
      const data = log.data;

      // 1. New Mobile API: { items: [...] } or { status: 'ok', items: [...] }
      let items = null;
      if (data.items && Array.isArray(data.items)) items = data.items;
      else if (data.data && data.data.user && data.data.user.edge_owner_to_timeline_media) items = data.data.user.edge_owner_to_timeline_media.edges.map(e => e.node);

      if (items && items.length > 0) {
        items.forEach(item => {
          try {
            const p = parsePost(item);
            if (p.shortcode) posts.push(p);
          } catch (e) { }
        });
      }
    }

    posts = posts.filter((v, i, a) => a.findIndex(v2 => (v2.shortcode === v.shortcode)) === i);

    if (posts.length > 0) {
      console.log(`Extracted ${posts.length} posts from network logs (Mobile/Graph API).`);
      return posts;
    }

    // --- GENERIC DOM FALLBACK (AGGRESSIVE) ---
    console.log('Network logs empty... Trying Aggressive DOM fallback...');

    let domPosts = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a')); // Get ALL links
      const data = [];
      const seenLinks = new Set();

      anchors.forEach(anchor => {
        const link = anchor.href;
        if (!link || (!link.includes('/p/') && !link.includes('/reel/'))) return;
        if (seenLinks.has(link)) return;

        // Get Image
        const img = anchor.querySelector('img');

        if (img && img.src) {
          const shortcodeMatch = link.match(/\/(?:p|reel)\/([^\/]+)\//);
          const shortcode = shortcodeMatch ? shortcodeMatch[1] : 'unknown';

          // Detect Video via URL or DOM clues
          const isReel = link.includes('/reel/');
          const hasVideoLabel = anchor.getAttribute('aria-label') === 'Reel' || !!anchor.querySelector('.coreSpritePlayIconSmall');

          data.push({
            id: shortcode,
            shortcode: shortcode,
            link: link,
            type: (isReel || hasVideoLabel) ? 'GraphVideo' : 'GraphImage',
            displayUrl: img.src,
            caption: img.alt || '',
            timestamp: Date.now() / 1000,
            isVideo: isReel || hasVideoLabel,
            isSidecar: false, // Default to false, fixed in hydration
            requires_hydration: true // Flag to tell scraper to visit page
          });
          seenLinks.add(link);
        }
      });
      return data.slice(0, 12);
    });

    if (domPosts.length > 0) {
      console.log(`DOM Fallback found ${domPosts.length} posts. Starting Deep Hydration (fetching video URLs)...`);

      // --- DEEP HYDRATION LOOP ---
      // Visit each post to get the actual Video URL and Sidecar data
      for (let i = 0; i < domPosts.length; i++) {
        const post = domPosts[i];
        try {
          // console.log(`Hydrating post ${i+1}/${domPosts.length}: ${post.shortcode}`);
          await page.goto(post.link, { waitUntil: 'domcontentloaded', timeout: 45000 });

          // Extract Sidecar? or Video?
          const metaData = await page.evaluate(() => {
            const getMeta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content;
            return {
              videoUrl: getMeta('og:video'),
              image: getMeta('og:image'),
              type: getMeta('og:type'),
              desc: getMeta('og:description'),
              isSidecar: !!document.querySelector('.coreSpriteRightChevron') || !!document.querySelector('ul._aca0') // Indicators of carousel
            };
          });

          // Merge Hydrated Data
          if (metaData.videoUrl) {
            post.isVideo = true;
            post.type = 'GraphVideo';
            post.videoUrl = metaData.videoUrl;
          }

          // Update image if higher quality available
          if (metaData.image) post.displayUrl = metaData.image;

          // Detect Sidecar (Basic meta detection)
          if (metaData.isSidecar) {
            post.isSidecar = true;
            post.type = 'GraphSidecar';
            // Note: Extracting all sidecar children via DOM is very hard without clicking.
            // We at least mark it correctly.
          }

        } catch (err) {
          console.log(`Failed to hydrate ${post.shortcode}: ${err.message}`);
        }

        // Random delay to be safe
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      }

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
