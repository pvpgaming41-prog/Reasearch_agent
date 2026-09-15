// core-research-agent — real headless-browser backend for CORE's Deep Research
//
// Protocol (matches CORE's frontend exactly):
//   Client -> Server:  { type: 'task', task: '<topic or instruction>' }
//   Server -> Client:  { type: 'log', text }
//                       { type: 'tool_call', name, input }
//                       { type: 'tab', title, url }
//                       { type: 'screenshot', dataUrl }
//                       { type: 'file_saved', filename }
//                       { type: 'error', text }
//                       { type: 'done' }
//
// Free/keyless by design: search is done against DuckDuckGo's HTML endpoint
// (no API key needed) and pages are visited with a real headless Chromium via
// Playwright, so JS-heavy sites, CORS-restricted sites, and screenshots all work —
// things the browser-only built-in mode can't do.

const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const MAX_RESULTS = 5; // pages visited per research run
const OUTPUT_DIR = path.join(__dirname, 'research_output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function slugify(s, max = 50) {
  return (s || 'page').replace(/[^a-z0-9]+/gi, '_').slice(0, max) || 'page';
}

async function searchDuckDuckGo(page, topic, ws) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic)}`;
  send(ws, { type: 'tool_call', name: 'search', input: { engine: 'duckduckgo', query: topic } });
  send(ws, { type: 'log', text: `Searching DuckDuckGo for "${topic}"…` });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const results = await page.$$eval('a.result__a', (links) =>
    links.map((a) => ({ title: a.textContent.trim(), url: a.href }))
  );

  const cleaned = results
    .map((r) => {
      // DuckDuckGo's HTML endpoint sometimes wraps result URLs in a redirect
      // param (uddg=) — unwrap it so we navigate to the real page.
      try {
        const u = new URL(r.url);
        const real = u.searchParams.get('uddg');
        return { title: r.title, url: real ? decodeURIComponent(real) : r.url };
      } catch {
        return r;
      }
    })
    .filter((r) => r.url && r.url.startsWith('http'));

  send(ws, { type: 'log', text: `Found ${cleaned.length} results.` });
  return cleaned.slice(0, MAX_RESULTS);
}

async function visitPage(browser, result, runDir, ws) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const { title, url } = result;
  send(ws, { type: 'tool_call', name: 'navigate', input: { url } });
  send(ws, { type: 'log', text: `Visiting ${url}` });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800); // let lazy content settle

    const pageTitle = (await page.title()) || title || url;
    send(ws, { type: 'tab', title: pageTitle, url });

    // Screenshot — this is the thing the CORS-limited built-in mode can't do at all.
    const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
    const dataUrl = `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`;
    send(ws, { type: 'screenshot', dataUrl });

    // Extract readable text (strip script/style/nav noise).
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script,style,nav,footer,header,noscript').forEach((el) => el.remove());
      return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
    });

    const filename = `${slugify(pageTitle)}.md`;
    const filePath = path.join(runDir, filename);
    fs.writeFileSync(filePath, `# ${pageTitle}\n${url}\n\n${text}`);
    send(ws, { type: 'file_saved', filename: `pages/${filename}` });

    const shotName = `${slugify(pageTitle)}.jpg`;
    fs.writeFileSync(path.join(runDir, 'screenshots', shotName), screenshotBuffer);
    send(ws, { type: 'file_saved', filename: `screenshots/${shotName}` });

    return { title: pageTitle, url, textLength: text.length };
  } catch (e) {
    send(ws, { type: 'log', text: `Failed to read ${url}: ${e.message}` });
    return null;
  } finally {
    await page.close();
  }
}

async function runResearch(ws, task) {
  const runId = Date.now();
  const runDir = path.join(OUTPUT_DIR, String(runId));
  fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });

  send(ws, { type: 'log', text: `Task received: "${task}"` });

  const browser = await chromium.launch({ headless: true });
  try {
    const searchPage = await browser.newPage();
    const topic = task && task.trim() ? task : 'trending news today';
    const results = await searchDuckDuckGo(searchPage, topic, ws);
    await searchPage.close();

    if (!results.length) {
      send(ws, { type: 'error', text: 'No search results found.' });
      return;
    }

    const visited = [];
    for (const r of results) {
      const v = await visitPage(browser, r, runDir, ws);
      if (v) visited.push(v);
    }

    const summaryPath = path.join(runDir, 'summary.md');
    let summary = `# Research run: ${topic}\n${new Date(runId).toISOString()}\n\n`;
    visited.forEach((v, i) => {
      summary += `${i + 1}. [${v.title}](${v.url}) — ${v.textLength} chars extracted\n`;
    });
    fs.writeFileSync(summaryPath, summary);
    send(ws, { type: 'file_saved', filename: 'summary.md' });

    send(ws, { type: 'log', text: `Done — visited ${visited.length}/${results.length} pages. Saved to ${runDir}` });
  } catch (e) {
    send(ws, { type: 'error', text: e.message });
  } finally {
    await browser.close();
    send(ws, { type: 'done' });
  }
}

const wss = new WebSocketServer({ port: PORT });
console.log(`core-research-agent listening on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', text: 'Invalid message (expected JSON).' });
    }
    if (msg.type !== 'task') return;
    try {
      await runResearch(ws, msg.task || '');
    } catch (e) {
      send(ws, { type: 'error', text: e.message });
      send(ws, { type: 'done' });
    }
  });
});
