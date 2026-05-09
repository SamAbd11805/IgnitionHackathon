/* claude-proxy.js
 * Local proxy that forwards browser requests to the Anthropic API.
 *
 * Why this exists:
 *   The Anthropic API key MUST stay server-side. The browser cannot call
 *   Anthropic directly without exposing it. This proxy reads the key from
 *   .env (root) or config/.env.development and relays requests on
 *   http://localhost:3334.
 *
 * Usage:
 *   1. Put ANTHROPIC_API_KEY=... in .env at the repo root
 *      (or config/.env.development — both are checked).
 *   2. npm run claude-proxy
 *   3. The Crime Sim panel's "AI Mayor" tab will connect automatically.
 */
'use strict';

const path = require('path');

// Load env from root .env first, then config/.env.development as fallback
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.ANTHROPIC_API_KEY) {
  require('dotenv').config({
    path: path.join(__dirname, '..', 'config', '.env.development')
  });
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌ ANTHROPIC_API_KEY not found.');
  console.error(
    '   Put it in .env at the repo root, or in config/.env.development.\n'
  );
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const Anthropic =
  require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, model_default: 'claude-opus-4-7' });
});

/**
 * POST /api/claude
 * Body: { messages, system, tools, model?, max_tokens? }
 * Returns the raw Anthropic response (or streaming chunks if ?stream=1).
 */
app.post('/api/claude', async (req, res) => {
  const {
    messages,
    system,
    tools,
    model = 'claude-opus-4-7',
    max_tokens: maxTokens = 4096
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // Adaptive thinking lets Claude decide when to reason; safe default.
      thinking: { type: 'adaptive' },
      ...(system ? { system } : {}),
      ...(tools && tools.length ? { tools } : {}),
      messages
    });
    res.json(response);
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(err.status || 500).json({
      error: err.message || String(err),
      type: err.type,
      status: err.status
    });
  }
});

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || '3334', 10);
app.listen(PORT, () => {
  console.log(`✓ Claude API proxy listening on http://localhost:${PORT}`);
  console.log(`  POST /api/claude        — forwards to claude-opus-4-7`);
  console.log(`  GET  /health            — sanity check\n`);
});
