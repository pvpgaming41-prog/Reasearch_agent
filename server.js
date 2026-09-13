// core-research-agent / server.js
//
// What this is: a real backend. Unlike a browser-sandboxed HTML page, this process has its own
// network access, its own filesystem, and drives a real (headless) Chromium browser via Playwright.
// An LLM (Claude) decides which tool to call next in a loop; each call and its result is streamed
// to any connected UI over WebSocket, so a frontend can show "what it's doing" live.
//
// Run:
//   npm install
//   npx playwright install chromium
//   cp .env.example .env   (then fill in ANTHROPIC_API_KEY)
//   npm start
//
// Then open public/client-example.html in a browser, or point another UI's WebSocket client at
// ws://localhost:8787.
//
// SECURITY: this process can browse anywhere and write files to WORKSPACE_DIR. Do not expose it
// on the open internet without adding authentication (e.g. a shared token checked in the WS
// upgrade handler) and tighter sandboxing (see notes at the bottom of this file).

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const WORKSPACE_DIR = path.resolve(__dirname, process.env.WORKSPACE_DIR || './workspace');

// Check https://docs.claude.com for the current model catalogue/IDs before deploying —
// this is deliberately a config constant rather than something buried in the loop below.
// Default is Haiku: hours-long research loops call the model on every single tool step, so the
// per-step model cost matters a lot more here than in a normal chat. Haiku is far cheaper per call;
// switch back to a bigger model (e.g. claude-sonnet-5) if you need better judgment on hard tasks.
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// There is no such thing as a research loop with no limit at all — every step is a real, billed
// API call against your Anthropic account, so an unbounded loop is an unbounded bill if something
// goes wrong (a page that keeps "almost" finishing, a bug, etc). What these two give you instead:
// effectively no limit for any realistic hours-long research session, plus a safety net so a stuck
// session can't run (and bill) forever unattended. Raise both freely; MAX_STEPS=0 or
// MAX_RUNTIME_MS=0 disables that particular cap entirely if you really want no ceiling.
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 2000);
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS ?? 6 * 60 * 60 * 1000); // 6 hours

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

await fs.mkdir(WORKSPACE_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Tools the model is allowed to call ----------
// Kept deliberately small: browser actions + a sandboxed file save. No generic shell/exec tool -
// that's a much bigger attack surface and isn't needed for "research and save what you find."
const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL and wait for the page to load.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_get_text',
    description: "Get the current page's visible text content (truncated to ~6000 chars).",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click the first element matching a CSS selector.',
    input_schema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  },
  {
    name: 'browser_type',
    description: 'Type text into the first element matching a CSS selector.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page and send it to the UI (does not return pixels to the model).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_file',
    description: 'Save text content to a file inside the research workspace on disk.',
    input_schema: {
      type: 'object',
      properties: { filename: { type: 'string' }, content: { type: 'string' } },
      required: ['filename', 'content'],
    },
  },
];

// ---------- Per-connection session ----------
wss.on('connection', (ws) => {
  let browser, context, page;
  let stopped = false;

  const send = (type, payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
  };

  async function ensureBrowser() {
    if (page) return page;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    return page;
  }

  // Runs one tool call for real and returns a plain-text result for the model.
  async function runTool(name, input) {
    send('tool_call', { name, input });
    switch (name) {
      case 'browser_navigate': {
        const p = await ensureBrowser();
        await p.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        send('tab', { url: p.url(), title: await p.title() });
        return `Navigated to ${p.url()} — title: "${await p.title()}"`;
      }
      case 'browser_get_text': {
        const p = await ensureBrowser();
        const text = await p.evaluate(() => document.body?.innerText || '');
        return text.slice(0, 6000);
      }
      case 'browser_click': {
        const p = await ensureBrowser();
        await p.click(input.selector, { timeout: 8000 });
        return `Clicked "${input.selector}"`;
      }
      case 'browser_type': {
        const p = await ensureBrowser();
        await p.fill(input.selector, input.text, { timeout: 8000 });
        return `Typed into "${input.selector}"`;
      }
      case 'browser_screenshot': {
        const p = await ensureBrowser();
        const buf = await p.screenshot({ type: 'jpeg', quality: 60 });
        send('screenshot', { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` });
        return 'Screenshot taken and sent to the UI.';
      }
      case 'save_file': {
        // Path traversal guard: resolve, then require the result to still be inside WORKSPACE_DIR.
        const target = path.resolve(WORKSPACE_DIR, input.filename);
        if (!target.startsWith(WORKSPACE_DIR)) throw new Error('Refusing to write outside the workspace directory.');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, input.content, 'utf8');
        send('file_saved', { filename: input.filename });
        return `Saved ${input.content.length} chars to ${input.filename}`;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async function agentLoop(task) {
    const messages = [{ role: 'user', content: task }];
    const system = [
      {
        type: 'text',
        text:
          'You are a research agent with a real headless browser and a real file workspace, driven through tools. ' +
          'Investigate the task using browser_navigate/browser_get_text/browser_click/browser_type/browser_screenshot. ' +
          'You are not on a short leash: for open-ended or "hours of research" tasks, keep going — follow links, ' +
          'cross-check multiple sources, revisit pages, and periodically save_file incremental notes/report sections ' +
          'as you go rather than only at the very end, so a save_file exists even if you get interrupted. ' +
          'Narrate briefly between actions. Only stop calling tools once the task is genuinely done.',
        // Prompt caching: system prompt + tool definitions repeat identically on every single step of
        // a long research loop. Marking this breakpoint means those tokens are cached rather than
        // re-billed at full price each step — the cost saving that matters most for hours-long runs.
        cache_control: { type: 'ephemeral' },
      },
    ];
    const startedAt = Date.now();

    for (let step = 0; ; step++) {
      if (stopped) return;
      if (MAX_STEPS && step >= MAX_STEPS) { send('done', { note: `Reached MAX_STEPS (${MAX_STEPS}). Raise it in .env if you need longer.` }); return; }
      if (MAX_RUNTIME_MS && Date.now() - startedAt >= MAX_RUNTIME_MS) { send('done', { note: `Reached MAX_RUNTIME_MS (${MAX_RUNTIME_MS}ms). Raise it in .env if you need longer.` }); return; }

      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system,
        messages,
        tools: TOOLS,
      });

      const textBlocks = response.content.filter((b) => b.type === 'text');
      for (const b of textBlocks) send('log', { text: b.text });

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) {
        send('done', {});
        return;
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const call of toolUses) {
        try {
          const result = await runTool(call.name, call.input);
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: result });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: ${e.message}`, is_error: true });
          send('error', { text: `${call.name} failed: ${e.message}` });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }
    send('done', { note: 'Reached step limit.' });
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'task' && typeof msg.task === 'string') {
      try {
        await agentLoop(msg.task);
      } catch (e) {
        send('error', { text: e.message });
      }
    } else if (msg.type === 'stop') {
      stopped = true;
    }
  });

  ws.on('close', async () => {
    stopped = true;
    if (browser) await browser.close().catch(() => {});
  });
});

server.listen(PORT, () => console.log(`core-research-agent listening on ws://localhost:${PORT}`));

// ---------- Hardening notes for anything beyond local/dev use ----------
// - Add auth: check a token on the WS upgrade request before accepting the connection.
// - Run the browser (and ideally the whole process) inside a container with no access to
//   anything sensitive on the host, and a resource/time limit per session.
// - Rate-limit and cap concurrent sessions per client.
// - Consider an allowlist/denylist of domains if this is meant for a specific research scope
//   rather than the open web.
