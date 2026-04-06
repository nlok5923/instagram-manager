// ─── Claude API Wrapper ───────────────────────────────────────────────────────
// Handles all communication with the Anthropic API.
// Supports: tool use loop, vision (base64 screenshots), streaming status.

const CLAUDE_MODEL = 'claude-opus-4-6';
const API_URL      = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS   = 4096;
const MAX_TOOL_ITERATIONS = 20; // safety cap per task

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
1. Always take a screenshot first to understand the current page state before acting.
2. Add human-like delays between actions (use the wait tool, 1-4 seconds).
3. Never comment the same post twice. Never follow the same account twice.
4. Keep comments specific to the post content — not generic. Reference the aircraft, angle, location, or story in the post.
5. Stay within safe daily limits: max 35 follows, 10 comments, 60 likes per day.
6. If something fails, try once more then report back rather than retrying endlessly.
7. When a task is complete, clearly say "TASK COMPLETE" followed by a brief summary.
8. When you need human approval (e.g., before posting), say "AWAITING APPROVAL" and describe what you're about to do.`;
}

// ─── Main: run a task with tool loop ─────────────────────────────────────────
// onStatus(text) — called with status updates as Claude works
// onToolCall(tool, params) — called before each tool execution
// executeToolOnTab(tool, params) — executes the tool in the Instagram tab
export async function runTask({ apiKey, config, taskDescription, conversationHistory = [], onStatus, executeToolOnTab, onError }) {
  const messages = [
    ...conversationHistory,
    { role: 'user', content: taskDescription },
  ];

  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    onStatus?.(`Thinking... (step ${iterations})`);

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
