// ─── AI Client ────────────────────────────────────────────────────────────────
// Supports two providers:
//   • Anthropic  (Claude models)  — x-api-key auth, Anthropic message format
//   • OpenAI-compatible           — Bearer auth, OpenAI message format
//                                   Works with Kimi, OpenRouter, etc.

const MAX_TOKENS         = 4096;
const MAX_TOOL_ITERATIONS = 100;

// ─── Tool Definitions (Anthropic format — converted for OpenAI when needed) ───
export const INSTAGRAM_TOOLS = [
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the current Instagram page. Use sparingly — prefer read_page for text extraction.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'navigate',
    description: 'Navigate to a URL within instagram.com.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full instagram.com URL, e.g. https://www.instagram.com/explore/tags/aviation/' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click an element on the page.',
    input_schema: {
      type: 'object',
      properties: {
        selector:    { type: 'string', description: 'CSS selector.' },
        description: { type: 'string', description: 'Human description, e.g. "Like button", "Follow button".' },
      },
    },
  },
  {
    name: 'type',
    description: 'Type text into a focused input field.',
    input_schema: {
      type: 'object',
      properties: {
        selector:    { type: 'string' },
        description: { type: 'string' },
        text:        { type: 'string', description: 'Text to type.' },
        clearFirst:  { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  {
    name: 'post_comment',
    description: 'Post a comment on the current Instagram post in one shot — click textarea, type text, wait for Post button, submit. Use this instead of separate click+type+click.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The comment text.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up'] },
        amount:    { type: 'number', description: 'Pixels. Default 600.' },
        selector:  { type: 'string' },
      },
    },
  },
  {
    name: 'read_page',
    description: 'Extract structured content from the current page. Prefer this over screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['full', 'posts', 'profile', 'post', 'feed'] },
      },
    },
  },
  {
    name: 'wait',
    description: 'Wait N seconds.',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '1–10. Default 2.' },
      },
    },
  },
  {
    name: 'inspect_dom',
    description: 'Inspect the current page DOM and return real selectors for key elements. Use when clicks fail.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ─── System Prompt ────────────────────────────────────────────────────────────
export function buildSystemPrompt(config) {
  return `You are an Instagram account manager for a hobby aviation account that posts videos about planes.

Account context:
- Niche: ${config.accountNiche}
- Tone: ${config.tonePreference}

Key rules:
1. Prefer read_page over screenshot — screenshots are expensive. Only screenshot when you need to see visual content.
2. Add human-like delays between actions (wait tool, 1-4 seconds).
3. Never comment the same post twice. Never follow the same account twice.
4. Comments must be specific — reference the actual aircraft, angle, or story in the post.
5. Daily limits: max 35 follows, 10 comments, 60 likes.
6. If a tool fails, try a different approach silently. Never ask the user to do anything.
7. If navigate or screenshot fails, wait 2 seconds and retry once, then skip.
8. When done, say "TASK COMPLETE" followed by a brief summary.
9. You have full autonomy. Handle all obstacles yourself.`;
}

// ─── Main Task Runner ─────────────────────────────────────────────────────────
export async function runTask({ apiKey, config, taskDescription, conversationHistory = [], onStatus, executeToolOnTab, onError }) {
  const provider = detectProvider(config);

  let messages = [
    ...conversationHistory,
    { role: 'user', content: taskDescription },
  ];

  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    onStatus?.(`Thinking... (step ${iterations})`);

    messages = pruneMessages(messages);

    const response = provider === 'anthropic'
      ? await callAnthropic({ apiKey, messages, config })
      : await callOpenAICompat({ apiKey, messages, config });

    if (response.error) {
      onError?.('api', `API error at step ${iterations}: ${response.error}`, taskDescription.slice(0, 100));
      return { ok: false, error: response.error };
    }

    // Normalise to Anthropic-style internally
    const normalised = provider === 'anthropic' ? response : normaliseOpenAIResponse(response);

    messages.push({ role: 'assistant', content: normalised.content, _reasoning_content: normalised._reasoning_content });

    if (normalised.stop_reason === 'end_turn' || normalised.stop_reason !== 'tool_use') {
      return { ok: true, result: extractText(normalised.content), messages };
    }

    // Execute tool calls
    const toolResults = [];

    for (const block of normalised.content) {
      if (block.type !== 'tool_use') continue;

      const { id, name, input } = block;
      onStatus?.(`Executing: ${name}${input.url ? ' → ' + input.url : ''}`);

      let result;
      try {
        result = await executeToolOnTab(name, name === 'screenshot' ? {} : input);
      } catch (err) {
        result = { ok: false, error: err.message };
        onError?.('tool_execution', `Tool "${name}" threw: ${err.message}`, JSON.stringify(input).slice(0, 200));
      }

      if (!result?.ok) {
        onError?.('tool_result', `Tool "${name}" failed: ${result?.error || 'unknown'}`, JSON.stringify(input).slice(0, 200));
      }

      // Screenshots → image blocks; everything else → JSON string
      let toolContent;
      const screenshot = result?.data?.screenshot;
      if (screenshot?.startsWith('data:')) {
        const [header, b64] = screenshot.split(',');
        const mediaType = header.match(/data:(.*);/)?.[1] || 'image/jpeg';
        toolContent = [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text',  text: 'Screenshot taken.' },
        ];
      } else {
        toolContent = JSON.stringify(result);
      }

      toolResults.push({ type: 'tool_result', tool_use_id: id, content: toolContent });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  const err = `Reached maximum iterations (${MAX_TOOL_ITERATIONS}).`;
  onError?.('iteration_cap', err, taskDescription.slice(0, 100));
  return { ok: false, error: err, messages };
}

// ─── Chat (no tools, single turn) ────────────────────────────────────────────
export async function chat({ apiKey, config, systemOverride, prompt, conversationHistory = [] }) {
  const provider = detectProvider(config);
  const messages = [...conversationHistory, { role: 'user', content: prompt }];

  const response = provider === 'anthropic'
    ? await callAnthropic({ apiKey, messages, config, systemOverride, noTools: true })
    : await callOpenAICompat({ apiKey, messages, config, systemOverride, noTools: true });

  if (response.error) return { ok: false, error: response.error };

  const normalised = provider === 'anthropic' ? response : normaliseOpenAIResponse(response);
  return { ok: true, text: extractText(normalised.content) };
}

// ─── Anthropic API Call ───────────────────────────────────────────────────────
async function callAnthropic({ apiKey, messages, config, systemOverride, noTools }) {
  try {
    const body = {
      model:      config.modelId || 'claude-sonnet-4-5',
      max_tokens: MAX_TOKENS,
      system:     systemOverride || buildSystemPrompt(config),
      messages:   toAnthropicMessages(messages),
    };
    if (!noTools) body.tools = INSTAGRAM_TOOLS;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) return { error: 'Invalid API key (401). Check Settings.' };
      if (res.status === 429) return { error: 'Rate limited (429). Will retry next cycle.' };
      return { error: err?.error?.message || `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: err.message === 'Failed to fetch' ? 'Network error — check connection.' : err.message };
  }
}

// ─── OpenAI-Compatible API Call (Kimi, OpenRouter, etc.) ─────────────────────
async function callOpenAICompat({ apiKey, messages, config, systemOverride, noTools }) {
  try {
    const system = systemOverride || buildSystemPrompt(config);
    const oaiMessages = [
      { role: 'system', content: system },
      ...toOpenAIMessages(messages),
    ];

    const body = {
      model:      config.modelId || 'kimi-k2',
      max_tokens: MAX_TOKENS,
      messages:   oaiMessages,
    };
    if (!noTools) {
      body.tools = toOpenAITools(INSTAGRAM_TOOLS);
      body.tool_choice = 'auto';
    }

    const baseUrl = config.apiBaseUrl || 'https://api.moonshot.cn/v1';

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) return { error: 'Invalid API key (401). Check Settings.' };
      if (res.status === 429) return { error: 'Rate limited (429). Will retry next cycle.' };
      return { error: err?.error?.message || `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: err.message === 'Failed to fetch' ? 'Network error — check connection.' : err.message };
  }
}

// ─── Format Converters ────────────────────────────────────────────────────────

// Anthropic tools → OpenAI function tools
function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name:        t.name,
      description: t.description,
      parameters:  t.input_schema,
    },
  }));
}

// Normalised internal messages → Anthropic wire format
// (strips tool_result image blocks if provider doesn't support them etc.)
function toAnthropicMessages(messages) {
  return messages; // already in Anthropic format internally
}

// Normalised internal messages → OpenAI wire format
function toOpenAIMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Convert tool_use blocks → tool_calls
      if (Array.isArray(msg.content)) {
        const toolCalls = msg.content
          .filter(b => b.type === 'tool_use')
          .map(b => ({
            id:       b.id,
            type:     'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
        out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined, ...(msg._reasoning_content !== undefined && { reasoning_content: msg._reasoning_content }) });
      } else {
        out.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Split tool_result blocks into separate tool messages
      const toolResults = msg.content.filter(b => b.type === 'tool_result');
      const userText    = msg.content.filter(b => b.type !== 'tool_result');

      for (const tr of toolResults) {
        const content = Array.isArray(tr.content)
          ? tr.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : String(tr.content);
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
      }
      if (userText.length) {
        out.push({ role: 'user', content: userText.map(b => b.text || '').join('\n') });
      }
    } else {
      out.push({ role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
    }
  }
  return out;
}

// OpenAI response → normalised Anthropic-style response
function normaliseOpenAIResponse(response) {
  const choice = response.choices?.[0];
  if (!choice) return { error: 'No choices in response' };

  const msg = choice.message;
  const content = [];

  if (msg.content) content.push({ type: 'text', text: msg.content });

  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      content.push({
        type:  'tool_use',
        id:    tc.id,
        name:  tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  const stop_reason = msg.tool_calls?.length ? 'tool_use' : 'end_turn';
  return { content, stop_reason, _reasoning_content: msg.reasoning_content ?? undefined };
}

// ─── Provider Detection ───────────────────────────────────────────────────────
function detectProvider(config) {
  // If a custom base URL is set, assume OpenAI-compatible
  if (config.apiBaseUrl) return 'openai_compat';
  // Default to Anthropic
  return 'anthropic';
}

// ─── Context Pruner ───────────────────────────────────────────────────────────
// Strips old screenshots and keeps message pairs intact.
function pruneMessages(messages) {
  // Step 1: strip image blocks from all but the last screenshot tool_result
  let lastScreenshotIdx = -1;
  messages.forEach((msg, i) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return;
    if (msg.content.some(b => b.type === 'tool_result' && Array.isArray(b.content) && b.content.some(c => c.type === 'image'))) {
      lastScreenshotIdx = i;
    }
  });

  messages = messages.map((msg, i) => {
    if (i === lastScreenshotIdx || msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map(block => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
        if (!block.content.some(c => c.type === 'image')) return block;
        return { ...block, content: [{ type: 'text', text: '[screenshot removed]' }] };
      }),
    };
  });

  // Step 2: hard cap — keep first message + last 25, but NEVER start tail on
  // a tool_result user message (that would orphan it from its tool_use pair)
  if (messages.length > 30) {
    const first = messages[0];
    let tail = messages.slice(-25);

    // Walk forward until we find an assistant message to anchor the tail
    let anchor = 0;
    while (anchor < tail.length && !(tail[anchor].role === 'assistant')) anchor++;
    if (anchor > 0 && anchor < tail.length) tail = tail.slice(anchor);

    messages = [first, ...tail];
  }

  return messages;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}
