# core-research-agent

A minimal backend that gives an LLM a **real** headless browser (Playwright) and a **real**
sandboxed file workspace, driven through a tool-calling loop, streamed live to a UI over
WebSocket. This is the piece a browser-only HTML page can never provide on its own.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY
npm start
```

Server listens on `ws://localhost:8787` (also serves `public/` over HTTP on the same port).

## Try it

Open `http://localhost:8787/client-example.html` in a browser, type a task like:

> Find the current top story on Hacker News, read the linked article, and save a 3-sentence summary.

and watch the log stream tool calls (`browser_navigate`, `browser_get_text`, ...), tab changes,
and screenshots in real time. Saved files land in `./workspace`.

## How it works

1. Your task goes to Claude with a small tool list: `browser_navigate`, `browser_get_text`,
   `browser_click`, `browser_type`, `browser_screenshot`, `save_file`.
2. Claude decides which tool to call; `server.js` actually executes it against a real Playwright
   page (or the real filesystem for `save_file`) and streams each step to any connected WebSocket
   client.
3. The tool's result goes back to Claude as a `tool_result`, and the loop continues (up to 20
   steps) until Claude stops calling tools.

## Wiring this to the CORE frontend

The Deep Research deck in `ai-core-v7-1-4-2.html` currently calls Wikipedia/HN APIs directly from
the browser. To point it at this backend instead:

- Replace its `fetch()` calls with a `WebSocket` connection to this server (same message shapes
  used in `public/client-example.html`).
- Render `tool_call`/`tab`/`screenshot`/`file_saved` events into the existing `#drLog`/`#drTabs`/
  `#drResults` elements instead of the Wikipedia/HN-specific rendering that's there now.
- This is a UI rewire, not a backend change — the message protocol above is stable to build against.

## Before running this anywhere but your own machine

This process can browse anywhere and write to disk. It has **no authentication** and **no
sandboxing beyond the workspace path check** by default. See the hardening notes at the bottom of
`server.js` before exposing it past localhost — at minimum: add a token check on the WebSocket
handshake, run it in a container with limited host access, and rate-limit sessions.
