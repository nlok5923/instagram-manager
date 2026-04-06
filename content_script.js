// ─── Content Script ───────────────────────────────────────────────────────────
// Runs inside instagram.com. Exposes tools to the background worker.
// navigate is NOT handled here — background uses chrome.tabs.update instead.

(() => {

  // ─── Instagram Element Map ────────────────────────────────────────────────
  // Stable ways to find key Instagram elements.
  // Instagram uses obfuscated class names that change — we prefer aria-label,
  // role, data attributes, and structural selectors over class names.
  const IG = {
    // Like button — scroll to top of post first, then look for the heart SVG
    likeButton: () => {
      // Try all known patterns
      return (
        document.querySelector('svg[aria-label="Like"]')?.closest('button') ||
        document.querySelector('svg[aria-label="Unlike"]')?.closest('button') ||
        // Fallback: find button near the action row (like/comment/share icons)
        [...document.querySelectorAll('section button, div[role="group"] button')]
          .find(b => b.querySelector('svg') && !b.querySelector('[aria-label*="comment" i]') && !b.querySelector('[aria-label*="share" i]')) ||
        null
      );
    },

    // Comment textarea — confirmed selector from DOM inspection
    commentInput: () =>
      document.querySelector('textarea[aria-label="Add a comment\u2026"]') ||
      document.querySelector('textarea[aria-label*="comment" i]') ||
      document.querySelector('textarea[placeholder*="comment" i]') ||
      document.querySelector('form textarea'),

    // Submit button — only appears AFTER text is typed into the comment box
    commentSubmit: () =>
      document.querySelector('button[type="submit"]') ||
      // Instagram renders "Post" as a div[role=button] or a plain button
      [...document.querySelectorAll('button, div[role="button"]')]
        .find(el => /^post$/i.test(el.innerText?.trim())) ||
      null,

    // Follow button — only present on profile pages, not post pages
    followButton: () =>
      [...document.querySelectorAll('button[type="button"]')]
        .find(b => /^follow$/i.test(b.innerText?.trim())) || null,

    // Already following
    followingButton: () =>
      [...document.querySelectorAll('button[type="button"]')]
        .find(b => /^following$/i.test(b.innerText?.trim())) || null,

    // Post + reel links
    postLinks: () => [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')],

    // Feed articles
    articles: () => [...document.querySelectorAll('article[role="presentation"], article')],
  };

  // ─── Tool: click ──────────────────────────────────────────────────────────
  async function toolClick({ selector, description }) {
    let el = null;

    // 1. Named Instagram element shortcuts (most reliable)
    if (description) {
      const desc = description.toLowerCase();
      if (desc.includes('like') && !desc.includes('unlike')) el = IG.likeButton();
      else if (desc.includes('follow') && !desc.includes('following')) el = IG.followButton();
      else if (desc.includes('comment') && desc.includes('submit')) el = IG.commentSubmit();
      else if (desc.includes('comment') && (desc.includes('box') || desc.includes('input'))) el = IG.commentInput();
    }

    // 2. CSS selector
    if (!el && selector) {
      el = document.querySelector(selector);
    }

    // 3. Fuzzy description fallback
    if (!el && description) {
      el = findElementByDescription(description);
    }

    if (!el) {
      return { ok: false, error: `Element not found: selector="${selector}" description="${description}"` };
    }

    // If we landed on an SVG or path, bubble up to the nearest clickable parent
    if (el instanceof SVGElement || el.tagName?.toLowerCase() === 'svg' || el.tagName?.toLowerCase() === 'path') {
      el = el.closest('button') || el.closest('[role="button"]') || el.closest('a') || el;
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);

    // Dispatch pointer events + click for React/Next.js event handlers
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown',   { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup',     { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click',       { bubbles: true, cancelable: true }));
    if (typeof el.click === 'function') el.click();

    await sleep(600);
    return { ok: true, data: { clicked: el.tagName, text: el.textContent?.slice(0, 80) } };
  }

  // ─── Tool: type ────────────────────────────────────────────────────────────
  async function toolType({ selector, description, text, clearFirst }) {
    let el = null;

    if (description?.toLowerCase().includes('comment')) el = IG.commentInput();
    if (!el && selector) el = document.querySelector(selector);
    if (!el && description) el = findElementByDescription(description);

    if (!el) return { ok: false, error: `Input not found: "${selector || description}"` };

    el.focus();
    await sleep(300);

    if (clearFirst) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
    }

    // React's synthetic event system needs the native setter
    const nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,   'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

    let accumulated = '';
    for (const char of text) {
      accumulated += char;
      if (nativeSetter) nativeSetter.call(el, accumulated);
      else el.value = accumulated;

      el.dispatchEvent(new Event('input',   { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { key: char, bubbles: true }));
      await sleep(randomBetween(40, 90));
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, data: { typed: `${text.length} characters` } };
  }

  // ─── Tool: post_comment ───────────────────────────────────────────────────
  // Full comment flow in one shot: click input → type → wait for Post btn → submit.
  async function toolPostComment({ text }) {
    if (!text) return { ok: false, error: 'No comment text provided.' };

    // 1. Find and click the comment textarea
    const input = IG.commentInput();
    if (!input) return { ok: false, error: 'Comment textarea not found. Are you on a post page?' };

    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);
    input.focus();
    input.click();
    await sleep(400);

    // 2. Type the comment using native setter (required for React).
    // We track accumulated text ourselves — never read input.value back,
    // because Instagram's React re-renders reset it between keystrokes.
    const nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

    let accumulated = '';
    for (const char of text) {
      accumulated += char;
      if (nativeSetter) nativeSetter.call(input, accumulated);
      else input.value = accumulated;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(randomBetween(40, 90));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 3. Wait up to 3s for the Post/Submit button to appear
    let submitBtn = null;
    for (let i = 0; i < 15; i++) {
      submitBtn = IG.commentSubmit();
      if (submitBtn) break;
      await sleep(200);
    }

    if (!submitBtn) return { ok: false, error: 'Submit button never appeared after typing.' };

    // 4. Click submit
    await sleep(300);
    submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (typeof submitBtn.click === 'function') submitBtn.click();
    await sleep(1000);

    return { ok: true, data: { commented: text.slice(0, 80) } };
  }

  // ─── Tool: scroll ─────────────────────────────────────────────────────────
  async function toolScroll({ direction = 'down', amount = 600, selector }) {
    const target = selector ? document.querySelector(selector) : window;
    if (!target) return { ok: false, error: `Scroll target not found: "${selector}"` };

    const scrollAmount = direction === 'up' ? -amount : amount;
    target === window
      ? window.scrollBy({ top: scrollAmount, behavior: 'smooth' })
      : target.scrollBy({ top: scrollAmount, behavior: 'smooth' });

    await sleep(800);
    return { ok: true, data: { scrollY: window.scrollY, pageHeight: document.body.scrollHeight } };
  }

  // ─── Tool: read_page ──────────────────────────────────────────────────────
  function toolReadPage({ mode = 'full' }) {
    const url = window.location.href;
    if (mode === 'posts' || url.includes('/explore/tags/') || url.includes('/explore/search/')) return readHashtagPage();
    if (mode === 'profile' || url.match(/instagram\.com\/[^/]+\/?$/)) return readProfilePage();
    if (mode === 'post'    || url.includes('/p/') || url.includes('/reel/')) return readPostPage();
    if (mode === 'feed'    || url === 'https://www.instagram.com/') return readFeedPage();
    return { ok: true, data: { url, title: document.title, text: document.body.innerText.slice(0, 3000) } };
  }

  function readHashtagPage() {
    const posts = IG.postLinks().slice(0, 20).map(a => ({
      url: a.href,
      alt: a.querySelector('img')?.alt?.slice(0, 200) || '',
    }));
    return { ok: true, data: { type: 'hashtag_page', url: window.location.href, posts } };
  }

  function readProfilePage() {
    const pathname = window.location.pathname.replace(/\//g, '');
    // Follower count — try multiple approaches Instagram uses
    const followerEl =
      document.querySelector('a[href$="/followers/"] span') ||
      document.querySelector('li:nth-child(2) span span') ||
      document.querySelector('span[title]');

    // Bio
    const bioEl =
      document.querySelector('span[class*="_aacl"]') ||
      document.querySelector('div[class*="biography"]') ||
      document.querySelector('h1 ~ span');

    // Is follow button present?
    const canFollow   = !!IG.followButton();
    const isFollowing = !!IG.followingButton();

    const recentPosts = IG.postLinks().slice(0, 12).map(a => a.href);

    return {
      ok: true,
      data: { type: 'profile', username: pathname, bio: bioEl?.innerText || '', followerCount: followerEl?.innerText || 'unknown', canFollow, isFollowing, recentPosts }
    };
  }

  function readPostPage() {
    // Caption: first meaningful text block under the post
    const captionEl =
      document.querySelector('div[class*="_a9zs"]') ||
      document.querySelector('h1') ||
      document.querySelector('article span[class*="_aacl"]');
    const caption = captionEl?.innerText || '';

    // Like count
    const likesEl =
      document.querySelector('span[class*="x193iq5w"]') ||
      document.querySelector('button span');
    const likes = likesEl?.innerText || '';

    // Already liked?
    const isLiked = !!document.querySelector('svg[aria-label="Unlike"]');

    // Comments
    const commentEls = [
      ...document.querySelectorAll('ul li span[class*="_aacl"]'),
      ...document.querySelectorAll('div[class*="_a9zs"] span'),
    ];
    const comments = [...new Set(commentEls.map(e => e.innerText?.trim()).filter(Boolean))].slice(0, 15);

    return { ok: true, data: { type: 'post', url: window.location.href, caption: caption.slice(0, 500), likes, isLiked, comments } };
  }

  function readFeedPage() {
    const posts = IG.articles().map(article => {
      const link = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      const caption = article.querySelector('span[class*="_aacl"]')?.innerText || '';
      return link ? { url: link.href, caption: caption.slice(0, 200) } : null;
    }).filter(Boolean);
    return { ok: true, data: { type: 'feed', posts: posts.slice(0, 10) } };
  }

  // ─── Tool: wait ───────────────────────────────────────────────────────────
  async function toolWait({ seconds = 2 }) {
    await sleep(Math.min(seconds, 10) * 1000);
    return { ok: true, data: { waited: `${seconds}s` } };
  }

  // ─── Tool: inspect_dom ────────────────────────────────────────────────────
  // Dumps the real selectors/HTML of key Instagram interactive elements.
  // Run this once to map the current DOM — feed results into Claude's context.
  function toolInspectDom() {
    const report = {};

    const checks = {
      like_button:     () => document.querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]')?.closest('button'),
      comment_input:   () => document.querySelector('textarea[placeholder*="comment" i], form textarea'),
      comment_submit:  () => document.querySelector('button[type="submit"]'),
      follow_button:   () => IG.followButton(),
      following_button:() => IG.followingButton(),
      post_links:      () => IG.postLinks()[0],
      first_article:   () => IG.articles()[0],
    };

    for (const [name, finder] of Object.entries(checks)) {
      const el = finder();
      if (el) {
        report[name] = {
          found:     true,
          tagName:   el.tagName,
          id:        el.id || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          role:      el.getAttribute('role') || null,
          // Stable selector path
          selector:  buildSelector(el),
          outerHTML: el.outerHTML.slice(0, 300),
        };
      } else {
        report[name] = { found: false };
      }
    }

    return { ok: true, data: { type: 'dom_inspection', url: window.location.href, elements: report } };
  }

  // Build a reasonably stable CSS selector for an element
  function buildSelector(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      let part = node.tagName.toLowerCase();
      if (node.id) { part += `#${node.id}`; parts.unshift(part); break; }
      if (node.getAttribute('aria-label')) part += `[aria-label="${node.getAttribute('aria-label')}"]`;
      else if (node.getAttribute('role'))  part += `[role="${node.getAttribute('role')}"]`;
      else if (node.getAttribute('type'))  part += `[type="${node.getAttribute('type')}"]`;
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 4) break;
    }
    return parts.join(' > ');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  function findElementByDescription(description) {
    const desc = description.toLowerCase();
    // aria-label (case-insensitive via filter)
    const allEls = [...document.querySelectorAll('[aria-label], [placeholder], button, a, div[role="button"]')];
    for (const el of allEls) {
      const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').toLowerCase();
      if (label.includes(desc)) return el;
    }
    return null;
  }

  // ─── Screenshot placeholder ───────────────────────────────────────────────
  async function toolScreenshot() {
    return { ok: true, data: { note: 'capture_via_background' } };
  }

  // ─── Message Router ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.source !== 'iam_background') return false;

    const { tool, params } = message;

    const run = async () => {
      try {
        switch (tool) {
          case 'screenshot':    return await toolScreenshot();
          case 'click':         return await toolClick(params);
          case 'type':          return await toolType(params);
          case 'scroll':        return await toolScroll(params);
          case 'read_page':     return toolReadPage(params);
          case 'wait':          return await toolWait(params);
          case 'post_comment':  return await toolPostComment(params);
          case 'inspect_dom':   return toolInspectDom();
          case 'ping':          return { ok: true };
          default:              return { ok: false, error: `Unknown tool: ${tool}` };
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };

    run().then(sendResponse);
    return true;
  });

  console.log('[IAM] Content script ready on', window.location.href);
})();
