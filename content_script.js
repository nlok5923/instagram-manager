// ─── Content Script ───────────────────────────────────────────────────────────
// Runs inside instagram.com. Exposes 7 tools to the background worker via
// chrome.runtime.onMessage. Each tool returns { ok, data, error }.

(() => {
  // ─── Tool: screenshot ──────────────────────────────────────────────────────
  // Captures the visible viewport as a base64 PNG using html2canvas-like
  // approach via the Chrome tab capture API (requested from background).
  // Content script signals background to do the actual capture.
  async function toolScreenshot() {
    return { ok: true, data: { note: 'capture_via_background' } };
  }

  // navigate is handled by the background service worker via chrome.tabs.update —
  // NOT here, because navigating destroys this script and closes the message channel.

  // ─── Tool: click ──────────────────────────────────────────────────────────
  async function toolClick({ selector, description }) {
    let el = null;

    if (selector) {
      el = document.querySelector(selector);
    }

    // Fallback: find by aria-label or text content matching description
    if (!el && description) {
      el = findElementByDescription(description);
    }

    if (!el) {
      return { ok: false, error: `Element not found: selector="${selector}" description="${description}"` };
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);
    el.click();
    await sleep(600);
    return { ok: true, data: { clicked: el.tagName, text: el.textContent?.slice(0, 80) } };
  }

  // ─── Tool: type ────────────────────────────────────────────────────────────
  async function toolType({ selector, description, text, clearFirst }) {
    let el = null;

    if (selector) el = document.querySelector(selector);
    if (!el && description) el = findElementByDescription(description);

    if (!el) {
      return { ok: false, error: `Input element not found: "${selector || description}"` };
    }

    el.focus();
    await sleep(300);

    if (clearFirst) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
    }

    // Type character by character to mimic human input
    for (const char of text) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, (el.value || '') + char);
      } else {
        el.value += char;
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(randomBetween(30, 90)); // human-like typing speed
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, data: { typed: text.length + ' characters' } };
  }

  // ─── Tool: scroll ─────────────────────────────────────────────────────────
  async function toolScroll({ direction = 'down', amount = 600, selector }) {
    const target = selector ? document.querySelector(selector) : window;
    if (!target) return { ok: false, error: `Scroll target not found: "${selector}"` };

    const scrollAmount = direction === 'up' ? -amount : amount;

    if (target === window) {
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    } else {
      target.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    }

    await sleep(800);
    return {
      ok: true,
      data: {
        scrollY: window.scrollY,
        pageHeight: document.body.scrollHeight,
      }
    };
  }

  // ─── Tool: read_page ──────────────────────────────────────────────────────
  // Extracts structured text from the current page.
  function toolReadPage({ mode = 'full' }) {
    const url = window.location.href;

    if (mode === 'posts' || url.includes('/explore/tags/')) {
      return readHashtagPage();
    }
    if (mode === 'profile' || url.match(/instagram\.com\/[^/]+\/?$/)) {
      return readProfilePage();
    }
    if (mode === 'post' || url.includes('/p/') || url.includes('/reel/')) {
      return readPostPage();
    }
    if (mode === 'feed' || url === 'https://www.instagram.com/') {
      return readFeedPage();
    }

    // Generic fallback
    return {
      ok: true,
      data: {
        url,
        title: document.title,
        text: document.body.innerText.slice(0, 3000),
      }
    };
  }

  function readHashtagPage() {
    const posts = [];
    // Instagram post links on hashtag/explore pages
    const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    links.forEach(link => {
      const img = link.querySelector('img');
      posts.push({
        url: link.href,
        alt: img?.alt?.slice(0, 200) || '',
      });
    });
    return { ok: true, data: { type: 'hashtag_page', url: window.location.href, posts } };
  }

  function readProfilePage() {
    const username = window.location.pathname.replace(/\//g, '');
    const followerEl = document.querySelector('a[href*="followers"] span, span[title]');
    const bioEl = document.querySelector('span._aacl._aaco._aacu._aacx._aad7._aade, div[data-testid="user-bio"]');
    const postLinks = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
      .slice(0, 12)
      .map(a => a.href);

    return {
      ok: true,
      data: {
        type: 'profile',
        username,
        bio: bioEl?.innerText || '',
        followerCount: followerEl?.innerText || 'unknown',
        recentPosts: postLinks,
      }
    };
  }

  function readPostPage() {
    const caption = document.querySelector('div._a9zs, h1._aacl, span._aacl')?.innerText || '';
    const likes = document.querySelector('span.x193iq5w, button span[class*="like"]')?.innerText || '';
    const comments = [...document.querySelectorAll('li._a9yw span._aacl, div._a9zm span')].map(
      el => el.innerText?.slice(0, 200)
    ).filter(Boolean).slice(0, 10);

    return {
      ok: true,
      data: {
        type: 'post',
        url: window.location.href,
        caption: caption.slice(0, 500),
        likes,
        comments,
      }
    };
  }

  function readFeedPage() {
    const posts = [];
    document.querySelectorAll('article').forEach(article => {
      const link = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      const caption = article.querySelector('span._aacl')?.innerText || '';
      if (link) {
        posts.push({ url: link.href, caption: caption.slice(0, 200) });
      }
    });
    return { ok: true, data: { type: 'feed', posts: posts.slice(0, 10) } };
  }

  // ─── Tool: wait ───────────────────────────────────────────────────────────
  async function toolWait({ seconds = 2 }) {
    await sleep(seconds * 1000);
    return { ok: true, data: { waited: seconds + 's' } };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function findElementByDescription(description) {
    const desc = description.toLowerCase();

    // Try aria-label
    const byAria = document.querySelector(`[aria-label*="${description}"]`);
    if (byAria) return byAria;

    // Try placeholder
    const byPlaceholder = document.querySelector(`[placeholder*="${description}"]`);
    if (byPlaceholder) return byPlaceholder;

    // Try button/span/div with matching text
    const candidates = document.querySelectorAll('button, a, span, div[role="button"]');
    for (const el of candidates) {
      if (el.textContent?.toLowerCase().includes(desc)) return el;
    }

    return null;
  }

  // ─── Message Router ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.source !== 'iam_background') return false;

    const { tool, params } = message;

    const run = async () => {
      try {
        switch (tool) {
          case 'screenshot':  return await toolScreenshot();
          case 'click':       return await toolClick(params);
          case 'type':        return await toolType(params);
          case 'scroll':      return await toolScroll(params);
          case 'read_page':   return toolReadPage(params);
          case 'wait':        return await toolWait(params);
          default:
            return { ok: false, error: `Unknown tool: ${tool}` };
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };

    run().then(sendResponse);
    return true; // keeps the message channel open for async response
  });

  console.log('[IAM] Content script loaded on', window.location.href);
})();
