# core-research-agent

Real headless-browser backend for CORE's Deep Research mode. Plugs straight into
the WebSocket protocol CORE's frontend already speaks — no changes needed on the
CORE side, just paste the server URL into Settings.

Free and keyless: search goes through DuckDuckGo's HTML endpoint (no API key),
and pages are visited with a real Chromium browser via Playwright. This gets you
past the two limits of CORE's built-in (browser-only) Deep Research mode:

- **CORS** — the built-in mode can only read sites that allow cross-origin
  fetches from a browser. This backend runs its own browser server-side, so it
  can visit anything.
- **JS-rendered content** — sites that build their content with JavaScript
  return nothing to a plain `fetch()`. A real headless browser renders them
  properly, so you get the actual text, not an empty shell.

It also captures real screenshots of every page it visits, which the built-in
mode can't do at all.

## Setup

```bash
npm install        # also runs `playwright install chromium` (downloads ~300MB)
npm start           # starts the WebSocket server on ws://localhost:8787
```

Set `PORT=xxxx` as an env var to use a different port.

## Connecting from CORE

1. Open CORE → Settings → Deep Research backend.
2. Paste `ws://localhost:8787` (or `wss://your-domain` if deployed remotely with TLS).
3. CORE stores the URL in its own localStorage and switches Deep Research to
   backend mode automatically. Leave the field blank to go back to built-in mode.

## What a research run does

1. Receives `{ type: 'task', task: '<topic>' }` over the WebSocket.
2. Searches DuckDuckGo's HTML endpoint for the topic (no API key required).
3. Visits the top 5 results in a real headless Chromium tab each:
   - takes a screenshot (streamed back live as `screenshot`)
   - extracts the readable text (scripts/nav/footer stripped)
   - saves the text as `pages/<title>.md` and the screenshot as
     `screenshots/<title>.jpg` under `research_output/<timestamp>/` on the
     server's disk
4. Writes a `summary.md` indexing everything it found.
5. Sends `{ type: 'done' }` when finished.

Every step streams back to CORE's UI in real time: search log lines, each tab
opened, each screenshot, each file saved.

## Deploying remotely

Any host that can run Node + Playwright's Chromium works (a small VPS, Fly.io,
Railway, Render, etc.). Two things matter:

- **Use `wss://` in production.** Browsers block a `wss://` page (CORE served
  over HTTPS) from opening a plain `ws://` connection, so you'll need TLS
  in front of the server (a reverse proxy like Caddy or nginx handles this
  easily, or use a host that terminates TLS for you).
- **Memory.** Headless Chromium needs roughly 300–500MB per concurrent research
  run. A 512MB–1GB instance is enough for light personal use.

No authentication is included — anyone with the URL can trigger a research run
and use your server's resources. Add a shared-secret check in the `connection`
handler (e.g. requiring a `?key=` query param) before exposing this publicly.

## Customizing

- `MAX_RESULTS` in `server.js` controls how many pages get visited per run
  (default 5).
- Swap `searchDuckDuckGo` for a different search backend if you prefer — the
  rest of the pipeline (visit, screenshot, extract, save) is search-engine
  agnostic.
