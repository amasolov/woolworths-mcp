// Woolworths API client: one browser page, and the API called from inside it.
//
// The APIs sit behind Akamai Bot Manager. A request needs the cookies a real
// browser earns on the homepage, and Akamai reportedly ties those cookies to
// the client that earned them - its IP and its TLS fingerprint. Earning them
// in Chromium and replaying them from Node's fetch therefore looks like two
// different clients sharing one session.
//
// So the server opens headless Chromium on the homepage and calls the API with
// the browser's own fetch(), as the website does: same browser, same cookies,
// same TLS, same origin. Two tabs: the homepage, where Akamai's script runs
// and keeps the cookies current, and an API tab on the same origin
// (robots.txt - no scripts, nothing to load) that makes the calls and never
// navigates, so reloading the homepage cannot kill a call in flight. The
// browser stays open while calls come in and closes after IDLE_CLOSE_MS
// without one; the next call reopens it (~1-3s).
//
// When Woolworths refuses a call anyway - a 403, or its bot-check page (HTTP
// 200 with HTML) - the homepage tab reloads once and the call is retried.
// A 401 is not retried: it means the endpoint wants a logged-in account.
//
// One page per process, shared by every MCP client: a client never has to set
// anything up.

import puppeteer, { Browser, Page } from "puppeteer";

export const BASE_URL = "https://www.woolworths.com.au";

// Never reopen or reload more often than this. If Woolworths keeps refusing
// (an IP block, say), each call fails fast instead of hammering the homepage.
const MIN_REFRESH_INTERVAL_MS = 60_000;
const IDLE_CLOSE_MS = 10 * 60 * 1000;

const NAVIGATION_TIMEOUT_MS = 45_000;
const SETTLE_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface Reply {
  status: number;
  text: string;
}

/** An open Woolworths page: calls the API from inside it. */
export interface Session {
  send(path: string, method: "GET" | "POST", body?: string): Promise<Reply>;
  /** Reload the homepage, which re-earns the cookies. */
  reload(): Promise<void>;
  close(): Promise<void>;
}

let session: Session | null = null;
let pending: Promise<Session> | null = null;
let lastAttempt = 0;
let lastError = "";
let idleTimer: NodeJS.Timeout | undefined;
let open: () => Promise<Session> = openSession;

export class WoolworthsError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

// Headless unless WOOLWORTHS_HEADLESS=false. Not a tool argument: a server with
// no display dies with "Missing X server" on a visible launch, and the caller
// cannot know whether there is one.
function headless(): boolean {
  return process.env.WOOLWORTHS_HEADLESS !== "false";
}

async function loadHomepage(page: Page) {
  // One retry: a navigation can fail on a blip that has nothing to do with
  // Woolworths (net::ERR_NETWORK_CHANGED in a container that just started).
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  } catch (error) {
    console.error(`[woolworths] homepage load failed, retrying once: ${(error as Error).message}`);
    await new Promise((r) => setTimeout(r, 1000));
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  }
  // The API accepts calls from about a second after DOMContentLoaded
  // (measured: Akamai's _abck never reaches its "validated" form in headless
  // Chromium, and does not need to). Let the page settle briefly, no more: it
  // keeps trackers polling, so networkidle can take 15s or never come.
  await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
}

async function openSession(): Promise<Session> {
  const browser: Browser = await puppeteer.launch({
    headless: headless(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    const userAgent = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
    const home = await browser.newPage();
    await home.setUserAgent(userAgent);
    await loadHomepage(home);
    const api = await browser.newPage();
    await api.setUserAgent(userAgent);
    await api.goto(`${BASE_URL}/robots.txt`, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    console.error("[woolworths] browser session open");
    return {
      async send(path, method, body) {
        return api.evaluate(
          async (path, method, body, timeoutMs) => {
            const r = await fetch(path, {
              method,
              credentials: "include",
              headers: {
                Accept: "application/json, text/plain, */*",
                ...(body ? { "Content-Type": "application/json" } : {}),
              },
              body: body ?? undefined,
              signal: AbortSignal.timeout(timeoutMs),
            });
            return { status: r.status, text: await r.text() };
          },
          path,
          method,
          body ?? null,
          REQUEST_TIMEOUT_MS
        );
      },
      reload: () => loadHomepage(home),
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

function closeSession(reason: string) {
  const s = session;
  session = null;
  clearTimeout(idleTimer);
  if (s) {
    console.error(`[woolworths] closing browser session (${reason})`);
    void s.close().catch(() => {});
  }
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeSession("idle"), IDLE_CLOSE_MS);
  idleTimer.unref();
}

// One open or reload at a time: concurrent callers share the in-flight one.
async function getSession(refresh = false): Promise<Session> {
  if (session && !refresh) return session;
  if (pending) return pending;

  // Reached only when the page has to be opened or reloaded: there is none, or
  // Woolworths just refused it. If the last attempt was moments ago, another
  // will not do better - that includes one that failed outright. (Opening
  // after the idle close is long past this window.)
  const sinceLast = Date.now() - lastAttempt;
  if (sinceLast < MIN_REFRESH_INTERVAL_MS) {
    const why = lastError ? `: ${lastError}` : " (Woolworths refused it)";
    throw new WoolworthsError(
      `No working Woolworths session${why}. Last attempt ${Math.round(sinceLast / 1000)}s ago; try again in a minute.`
    );
  }

  lastAttempt = Date.now();
  const current = session;
  pending = (async () => {
    if (current) {
      try {
        await current.reload();
        console.error("[woolworths] reloaded the homepage");
        return current;
      } catch (error) {
        console.error(`[woolworths] reload failed, reopening: ${(error as Error).message}`);
        closeSession("reload failed");
      }
    }
    return (session = await open());
  })()
    .then((s) => {
      lastError = "";
      return s;
    })
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[woolworths] session failed: ${lastError}`);
      throw error;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

// --- pacing -----------------------------------------------------------------
//
// Even from a real page, a burst of API calls draws Akamai's bot-check page
// (HTTP 200, HTML instead of JSON) for a minute or more; a client fanning out
// get_product_details over a search page was enough. So calls are paced (at
// most MAX_IN_FLIGHT at once, starts at least MIN_SPACING_MS apart), identical
// calls are answered from a short cache, and once blocked the server stops
// calling for BLOCK_COOLDOWN_MS rather than prolonging it.

const MAX_IN_FLIGHT = 2;
let minSpacingMs = 250;
const BLOCK_COOLDOWN_MS = 60_000;

let inFlight = 0;
let nextStart = 0;
const waiting: Array<() => void> = [];
let blockedUntil = 0;

async function acquireSlot(): Promise<() => void> {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  const start = Math.max(Date.now(), nextStart);
  nextStart = start + minSpacingMs;
  if (start > Date.now()) await new Promise((r) => setTimeout(r, start - Date.now()));
  return () => {
    inFlight--;
    waiting.shift()?.();
  };
}

// A small TTL cache of parsed responses, keyed by method, path and body.
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { expires: number; value: unknown }>();

function cached(key: string): unknown {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires > Date.now()) return hit.value;
  cache.delete(key);
  return undefined;
}

function remember(key: string, value: unknown, ttlMs: number) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + ttlMs, value });
}

const RATE_LIMITED =
  "Woolworths is rate-limiting this server: it answered with its bot-check page instead of data. " +
  "Retry in a minute or two, and make fewer calls - more requests now only prolong it.";

type Outcome = { kind: "json"; value: unknown } | { kind: "rejected"; status: number };

// One paced call. "rejected" is a 403 or the bot-check page: both mean
// Woolworths no longer accepts the session, and both are worth one reload.
async function attempt(path: string, method: "GET" | "POST", body: string | undefined, s: Session): Promise<Outcome> {
  const release = await acquireSlot();
  try {
    let reply: Reply;
    try {
      reply = await s.send(path, method, body);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (/timeout|timed out|aborted/i.test(message)) {
        throw new WoolworthsError(
          `Woolworths did not answer ${path} within ${REQUEST_TIMEOUT_MS / 1000}s. It may be rate-limiting this server; retry in a minute.`
        );
      }
      // The tab itself is gone (crashed or closed): drop the browser so the
      // next call opens a fresh one.
      if (/Target closed|Session closed|detached|Execution context was destroyed|Protocol error/i.test(message)) {
        closeSession(`page failed: ${message}`);
      }
      throw error;
    } finally {
      touch();
    }
    if (reply.status === 403) return { kind: "rejected", status: 403 };
    if (reply.status < 200 || reply.status >= 300) {
      throw new WoolworthsError(
        `Woolworths API ${reply.status} for ${path}${reply.text ? `: ${reply.text.slice(0, 300)}` : ""}`,
        reply.status
      );
    }
    if (reply.text.trimStart().startsWith("<")) return { kind: "rejected", status: reply.status };
    try {
      return { kind: "json", value: JSON.parse(reply.text) };
    } catch {
      throw new WoolworthsError(`Woolworths returned something other than JSON for ${path}: ${reply.text.slice(0, 120)}`);
    }
  } finally {
    release();
  }
}

/**
 * GET or POST a Woolworths API path from the browser page, with pacing, block
 * handling and an optional cache. Returns parsed JSON. With `cacheMs`, an
 * identical call within that time is answered from memory; treat the result
 * as read-only.
 */
export async function request<T = any>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; cacheMs?: number } = {}
): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const key = `${method} ${path} ${body ?? ""}`;
  if (init.cacheMs) {
    const hit = cached(key);
    if (hit !== undefined) return hit as T;
  }
  if (Date.now() < blockedUntil) throw new WoolworthsError(RATE_LIMITED, 429);

  let outcome = await attempt(path, method, body, await getSession());
  if (outcome.kind === "rejected") {
    console.error(`[woolworths] ${outcome.status === 403 ? "403" : "bot-check page"} on ${path}, reloading the homepage`);
    outcome = await attempt(path, method, body, await getSession(true));
  }
  if (outcome.kind === "rejected") {
    blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
    console.error(`[woolworths] still rejected after a reload; pausing calls for ${BLOCK_COOLDOWN_MS / 1000}s`);
    throw new WoolworthsError(RATE_LIMITED, 429);
  }

  if (init.cacheMs) remember(key, outcome.value, init.cacheMs);
  return outcome.value as T;
}

/** Close the browser, if open. For shutdown. */
export function shutdown() {
  closeSession("shutdown");
}

/** Test seam: replace the browser and reset all session, pacing and cache state. */
export function _resetForTests(fake?: () => Promise<Session>, opts: { minSpacingMs?: number } = {}) {
  clearTimeout(idleTimer);
  session = null;
  pending = null;
  lastAttempt = 0;
  lastError = "";
  open = fake ?? openSession;
  minSpacingMs = opts.minSpacingMs ?? 0;
  nextStart = 0;
  blockedUntil = 0;
  cache.clear();
}
