/* claude-proxy.js
 * Local proxy that forwards browser requests to the Groq API.
 * (Originally Anthropic — kept the same script name + endpoint URL so the
 * React panel does not need to change. The proxy translates between the
 * Anthropic-style wire format the panel uses and Groq's OpenAI-compatible
 * format.)
 *
 * Why this exists:
 *   The API key MUST stay server-side. The browser cannot call providers
 *   directly without exposing it. This proxy reads GROQ_API_KEY from .env
 *   (root) or config/.env.development and relays requests on
 *   http://localhost:3334.
 *
 * Usage:
 *   1. Put GROQ_API_KEY=... in .env at the repo root.
 *   2. npm run claude-proxy
 *   3. The Crime Sim panel's "AI" tab will connect automatically.
 */
'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.GROQ_API_KEY) {
  require('dotenv').config({
    path: path.join(__dirname, '..', 'config', '.env.development')
  });
}

if (!process.env.GROQ_API_KEY) {
  console.error('\n❌ GROQ_API_KEY not found.');
  console.error(
    '   Put it in .env at the repo root, or in config/.env.development.\n'
  );
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk').default || require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
// Llama 3.3 70B Versatile: Groq's strongest tool-use model on the free tier.
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// ── Anthropic ↔ OpenAI/Groq translation ────────────────────────────────────
// Anthropic format → Groq (OpenAI-compatible) format.
function toGroq({ messages, system, tools }) {
  const out = [];

  if (system) {
    out.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    // Plain string content → straight passthrough
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text);
      const toolCalls = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input || {})
          }
        }));

      const m = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null
      };
      if (toolCalls.length > 0) {
        m.tool_calls = toolCalls;
      }
      out.push(m);
    } else if (msg.role === 'user') {
      // Tool results become separate "tool" role messages (one per result)
      const toolResults = msg.content.filter((b) => b.type === 'tool_result');
      const textParts = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text);

      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content:
            typeof tr.content === 'string'
              ? tr.content
              : JSON.stringify(tr.content)
        });
      }
      if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
    }
  }

  const groqTools =
    tools && tools.length > 0
      ? tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema
          }
        }))
      : undefined;

  return { messages: out, tools: groqTools };
}

// Groq response → Anthropic-format response.
function fromGroq(response) {
  const choice = response && response.choices && response.choices[0];
  if (!choice) {
    return {
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      model: (response && response.model) || DEFAULT_MODEL
    };
  }

  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === 'string' && msg.content.length > 0) {
    content.push({ type: 'text', text: msg.content });
  }

  let hasToolUse = false;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      hasToolUse = true;
      let input = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (_) {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  let stopReason = 'end_turn';
  if (hasToolUse || choice.finish_reason === 'tool_calls') {
    stopReason = 'tool_use';
  } else if (choice.finish_reason === 'length') {
    stopReason = 'max_tokens';
  }

  return {
    content,
    stop_reason: stopReason,
    model: response.model || DEFAULT_MODEL,
    usage: response.usage
      ? {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens
        }
      : undefined
  };
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, provider: 'groq', model_default: DEFAULT_MODEL });
});

/**
 * POST /api/claude
 * Body: { messages, system, tools, model?, max_tokens? }
 * Returns an Anthropic-style { content, stop_reason, model, usage } object
 * regardless of which provider runs underneath.
 */
app.post('/api/claude', async (req, res) => {
  const {
    messages,
    system,
    tools,
    model = DEFAULT_MODEL,
    max_tokens: maxTokens = 4096
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const { messages: groqMessages, tools: groqTools } = toGroq({
      messages,
      system,
      tools
    });

    const response = await groq.chat.completions.create({
      model,
      messages: groqMessages,
      max_tokens: maxTokens,
      ...(groqTools ? { tools: groqTools, tool_choice: 'auto' } : {})
    });

    res.json(fromGroq(response));
  } catch (err) {
    console.error('Groq API error:', err.message || err);
    res.status(err.status || 500).json({
      error: err.message || String(err),
      type: err.name,
      status: err.status
    });
  }
});

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || '3334', 10);
app.listen(PORT, () => {
  console.log(`✓ AI proxy listening on http://localhost:${PORT}`);
  console.log(`  provider: Groq  •  default model: ${DEFAULT_MODEL}`);
  console.log(`  POST /api/claude        — accepts Anthropic-format wire`);
  console.log(`  GET  /health            — sanity check\n`);
});
