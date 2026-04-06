// ─── Claude API Wrapper ───────────────────────────────────────────────────────
// Handles all communication with the Anthropic API.
// Supports: tool use loop, vision (base64 screenshots), streaming status.

const CLAUDE_MODEL = 'claude-sonnet-4-5';
const API_URL      = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS   = 4096;
const MAX_TOOL_ITERATIONS = 100; // safety cap per task

// ─── Tool Definitions (what Claude can do on Instagram) ───────────────────────
export const INSTAGRAM_TOOLS = [
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the current Instagram page to see what is visible.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate to a URL within instagram.com.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full instagram.com URL to navigate to. E.g. https://www.instagram.com/explore/tags/aviation/',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click on an element on the page.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element. Use this when you know the exact selector.',
        },
        description: {
          type: 'string',
          description: 'Human description of the element to click (e.g. "Follow button", "Comment box", "Post button"). Used as fallback when selector is unknown.',
        },
      },
    },
  },
  {
    name: 'type',
    description: 'Type text into a focused input field or textarea.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input/textarea.',
        },
        description: {
          type: 'string',
          description: 'Human description of the field (e.g. "comment input", "caption field").',
        },
        text: {
          type: 'string',
          description: 'Text to type into the field.',
        },
        clearFirst: {
          type: 'boolean',
          description: 'Clear existing content before typing. Default false.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page to load more content.',
    input_schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up'],
          description: 'Scroll direction. Default: down.',
        },
        amount: {
          type: 'number',
          description: 'Pixels to scroll. Default: 600.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of scrollable container. Omit to scroll the window.',
        },
      },
    },
  },
  {
    name: 'read_page',
    description: 'Extract structured content from the current page without taking a screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['full', 'posts', 'profile', 'post', 'feed'],
          description: 'Extraction mode. "posts" for hashtag pages, "profile" for user profiles, "post" for a single post, "feed" for home feed.',
        },
      },
    },
  },
  {
    name: 'wait',
    description: 'Wait for a number of seconds. Use to let pages load or to add human-like delays.',
    input_schema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'Number of seconds to wait (1-10). Default: 2.',
        },
      },
    },
  },
  {
    name: 'post_comment',
    description: 'Post a comment on the current Instagram post. Handles the full flow: clicks the textarea, types the text, waits for the Post button to appear, then submits. Use this instead of separate click+type+click steps.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The comment text to post.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'inspect_dom',
    description: 'Inspect the current Instagram page and return the real selectors and HTML of key interactive elements (like button, follow button, comment input, etc.). Use this when click fails to understand the actual DOM structure.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─── System Prompt ────────────────────────────────────────────────────────────
export function buildSystemPrompt(config) {
  return `You are an Instagram account manager for a hobby aviation account that posts videos about planes, aircraft, and aviation.

Account context:
- Niche: ${config.accountNiche}
- Tone: ${config.tonePreference}
- Platform: Instagram (web, logged-in browser session)

Your job is to take actions on Instagram using the provided tools. You see the page via screenshots and can interact with it like a human would.

Key rules:
1. Prefer read_page over screenshot whenever possible — screenshots consume a lot of context. Only take a screenshot when you genuinely need to see visual elements (images, layout) that read_page cannot capture.
2. Add human-like delays between actions (use the wait tool, 1-4 seconds).
3. Never comment the same post twice. Never follow the same account twice.
4. Keep comments specific to the post content — not generic. Reference the aircraft, angle, location, or story in the post.
5. Stay within safe daily limits: max 35 follows, 10 comments, 60 likes per day.
6. If a tool fails, try a different approach silently — NEVER ask the user to fix permissions, refresh the browser, or take any manual action. You are fully autonomous.
7. If navigate or screenshot fails, wait 2 seconds and retry once. If it fails again, skip that page and move to the next one.
8. When a task is complete, clearly say "TASK COMPLETE" followed by a brief summary.
9. You have full autonomy. Never ask the user to do anything — handle all obstacles yourself.`;
}

// ─── Main: run a task with tool loop ─────────────────────────────────────────
// onStatus(text) — called with status updates as Claude works
// onToolCall(tool, params) — called before each tool execution
// executeToolOnTab(tool, params) — executes the tool in the Instagram tab
export async function runTask({ apiKey, config, taskDescription, conversationHistory = [], onStatus, executeToolOnTab, onError }) {
  let messages = [
    ...conversationHistory,
    { role: 'user', content: taskDescription },
  ];

  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    onStatus?.(`Thinking... (step ${iterations})`);

    // Prune context every 5 steps to stay under the 200k token limit
    if (iterations % 5 === 0) {
      messages = pruneMessages(messages);
    }

    const response = await callClaude({ apiKey, messages, config });

    if (response.error) {
      const msg = `Claude API error at step ${iterations}: ${response.error}`;
      onError?.('claude_api', msg, `Task: ${taskDescription.slice(0, 100)}`);
      return { ok: false, error: response.error };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
      return { ok: true, result: extractText(response.content), messages };
    }

    // Process tool calls
    const toolResults = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const { id, name, input } = block;
      onStatus?.(`Executing: ${name}${input.url ? ' → ' + input.url : ''}`);

      let result;
      try {
        result = await executeToolOnTab(name === 'screenshot' ? 'screenshot' : name, name === 'screenshot' ? {} : input);
      } catch (err) {
        result = { ok: false, error: err.message };
        onError?.('tool_execution', `Tool "${name}" threw: ${err.message}`, JSON.stringify(input).slice(0, 200));
      }

      // Log tool-level failures so they surface in the activity log
      if (!result?.ok) {
        onError?.('tool_result', `Tool "${name}" failed: ${result?.error || 'unknown'}`, JSON.stringify(input).slice(0, 200));
      }

      toolResults.push({
        type:        'tool_result',
        tool_use_id: id,
        content:     JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  const iterError = `Reached maximum tool iterations (${MAX_TOOL_ITERATIONS}). Task may be incomplete.`;
  onError?.('iteration_cap', iterError, taskDescription.slice(0, 100));
  return { ok: false, error: iterError, messages };
}

// ─── Context Pruner ───────────────────────────────────────────────────────────
// Keeps the message list under the 200k token limit by:
// 1. Stripping base64 screenshot data from all but the last 2 tool results
// 2. Removing middle message pairs when history grows very long
function pruneMessages(messages) {
  // Step 1: strip screenshot base64 from all tool_result messages except the last 2
  let screenshotsSeen = 0;
  const screenshotCount = messages.reduce((n, msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return n;
    return n + msg.content.filter(b => {
      if (b.type !== 'tool_result') return false;
      try { return !!JSON.parse(b.content)?.data?.screenshot; } catch { return false; }
    }).length;
  }, 0);

  const keepLastN = 2; // keep last N screenshots intact

  messages = messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map(block => {
        if (block.type !== 'tool_result') return block;
        try {
          const parsed = JSON.parse(block.content);
          if (parsed?.data?.screenshot) {
            screenshotsSeen++;
            // Strip all but the last keepLastN screenshots
            if (screenshotsSeen <= screenshotCount - keepLastN) {
              return { ...block, content: JSON.stringify({ ok: true, data: { note: '[screenshot removed to save context]' } }) };
            }
          }
        } catch {}
        return block;
      }),
    };
  });

  // Step 2: if still very long (>60 messages), drop middle pairs
  // Always keep: first message (task) + last 20 messages
  if (messages.length > 60) {
    const first = messages.slice(0, 1);
    const tail  = messages.slice(-20);
    messages = [...first, ...tail];
  }

  return messages;
}

// ─── Single Claude API Call ───────────────────────────────────────────────────
async function callClaude({ apiKey, messages, config }) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':            'application/json',
        'x-api-key':               apiKey,
        'anthropic-version':       '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system:     buildSystemPrompt(config),
        tools:      INSTAGRAM_TOOLS,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${response.status} ${response.statusText}`;
      // Surface rate limits and auth errors clearly
      if (response.status === 401) return { error: `Invalid API key (401). Check Settings.` };
      if (response.status === 429) return { error: `Rate limited by Anthropic (429). Will retry next cycle.` };
      if (response.status === 529) return { error: `Anthropic API overloaded (529). Will retry next cycle.` };
      return { error: msg };
    }

    return await response.json();
  } catch (err) {
    // Network-level error (DNS, CORS, service worker killed, etc.)
    const detail = err.name === 'TypeError' && err.message === 'Failed to fetch'
      ? 'Network error — check internet connection or extension permissions.'
      : err.message;
    return { error: detail };
  }
}

// ─── Chat (single turn, no tool loop) ────────────────────────────────────────
// Used for caption generation, hashtag suggestions, briefings — no browser actions needed.
export async function chat({ apiKey, config, systemOverride, prompt, conversationHistory = [] }) {
  const messages = [
    ...conversationHistory,
    { role: 'user', content: prompt },
  ];

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':            'application/json',
      'x-api-key':               apiKey,
      'anthropic-version':       '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemOverride || buildSystemPrompt(config),
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return { ok: false, error: err?.error?.message || `API error ${response.status}` };
  }

  const data = await response.json();
  return { ok: true, text: extractText(data.content) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}
