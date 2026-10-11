// Woolworths API client. Owns the session cookies, so callers never see them.
//
// The APIs sit behind Akamai bot protection: a request without the cookies a
// real browser picks up on the homepage gets a 403. So the first call launches
// headless Chromium once, loads the homepage, keeps its cookies and closes the
// browser. Later calls reuse the cookies until one comes back 403 or as the
// bot-check page - Akamai's answers once they expire - then they are
// refreshed once and the call retried. A 401 is not refreshed: it means the endpoint wants a logged-in
// account, which fresh anonymous cookies cannot provide.
//
// The cookies are per process, not per MCP session: one Chromium per pod
// rather than one per client, and a client never has to set anything up.

import puppeteer from "puppeteer";

export const BASE_URL = "https://www.woolworths.com.au";

// Never relaunch Chromium more often than this. If Woolworths keeps refusing
// fresh cookies (an IP block, say), each call fails fast instead of starting
// a browser per request.
const MIN_REFRESH_INTERVAL_MS = 60_000;

const NAVIGATION_TIMEOUT_MS = 45_000;
const SETTLE_TIMEOUT_MS = 3_000;

interface Session {
  cookieHeader: string;
  // The browser's own user agent, minus "Headless", used for the API calls
  // too, so they present as the client that earned the cookies.
  userAgent: string;
  capturedAt: number;
}

let session: Session | null = null;
let pending: Promise<Session> | null = null;
let lastAttempt = 0;
let lastError = "";
let capture: () => Promise<Session> = captureSession;

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

async function captureSession(): Promise<Session> {
  const browser = await puppeteer.launch({
    headless: headless(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    const userAgent = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    // One retry: a navigation can fail on a blip that has nothing to do with
    // Woolworths (net::ERR_NETWORK_CHANGED in a container that just started),
    // and the browser is already up.
    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      console.error(`[woolworths] homepage load failed, retrying once: ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    }
    // The API accepts the cookies from about a second after DOMContentLoaded
    // (measured: Akamai's _abck never reaches its "validated" form in headless
    // Chromium, and does not need to). Give the page a short moment to settle,
    // but no more: it keeps trackers polling, so networkidle can take 15s or
    // never come, and waiting for it once made the first call time out.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    // The browser context holds every site's cookies, trackers included; send
    // Woolworths only its own. (Page.cookies() did that filtering, and is
    // deprecated from Puppeteer 24.)
    const cookies = (await browser.cookies()).filter((c) => /(^|\.)woolworths\.com\.au$/.test(c.domain.replace(/^\./, "")));
    if (cookies.length === 0) {
      throw new WoolworthsError("Woolworths homepage set no cookies");
    }
    console.error(`[woolworths] captured ${cookies.length} cookies`);
    return {
      cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      userAgent,
      capturedAt: Date.now(),
    };
  } finally {
    await browser.close();
  }
}

// One capture at a time: concurrent callers share the in-flight one.
async function getSession(forceRefresh = false): Promise<Session> {
  if (session && !forceRefresh) return session;
  if (pending) return pending;

  // Reached only when a capture is needed: none yet, or the cookies were just
  // rejected. Either way, if the last capture was moments ago, a new one will
  // not do better - that includes a capture that failed outright.
  const sinceLast = Date.now() - lastAttempt;
  if (sinceLast < MIN_REFRESH_INTERVAL_MS) {
    const why = lastError ? `: ${lastError}` : " (Woolworths refused its cookies)";
    throw new WoolworthsError(
      `No working Woolworths session${why}. Last attempt ${Math.round(sinceLast / 1000)}s ago; try again in a minute.`
    );
  }

  lastAttempt = Date.now();
  pending = capture()
    .then((s) => {
      lastError = "";
      return (session = s);
    })
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[woolworths] cookie capture failed: ${lastError}`);
      throw error;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

async function send(path: string, init: RequestInit, s: Session): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "User-Agent": s.userAgent,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-AU,en;q=0.9",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      Cookie: s.cookieHeader,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// --- pacing -----------------------------------------------------------------
//
// Woolworths answers a burst of API calls with Akamai's bot-check page: HTTP
// 200, HTML instead of JSON, for a minute or more. A client fanning out
// get_product_details over a search page is enough to trigger it. So calls
// are paced (at most MAX_IN_FLIGHT at once, starts at least MIN_SPACING_MS
// apart), identical calls are answered from a short cache, and once blocked
// the server stops calling for BLOCK_COOLDOWN_MS rather than prolonging it.

const MAX_IN_FLIGHT = 2;
let minSpacingMs = 250;
const BLOCK_COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

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

// One paced call. "rejected" is a 403 or the bot-check page: both mean the
// cookies are no longer accepted, and both are worth exactly one refresh.
async function attempt(path: string, init: RequestInit, s: Session): Promise<Outcome> {
  const release = await acquireSlot();
  try {
    let response: Response;
    try {
      response = await send(path, init, s);
    } catch (error) {
      if ((error as Error).name === "TimeoutError") {
        throw new WoolworthsError(
          `Woolworths did not answer ${path} within ${REQUEST_TIMEOUT_MS / 1000}s. It may be rate-limiting this server; retry in a minute.`
        );
      }
      throw error;
    }
    if (response.status === 403) {
      await response.body?.cancel();
      return { kind: "rejected", status: 403 };
    }
    const text = await response.text();
    if (!response.ok) {
      throw new WoolworthsError(
        `Woolworths API ${response.status} ${response.statusText} for ${path}${text ? `: ${text.slice(0, 300)}` : ""}`,
        response.status
      );
    }
    if (text.trimStart().startsWith("<")) return { kind: "rejected", status: response.status };
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {
      throw new WoolworthsError(`Woolworths returned something other than JSON for ${path}: ${text.slice(0, 120)}`);
    }
  } finally {
    release();
  }
}

/**
 * GET or POST a Woolworths API path, handling cookies, pacing and blocks.
 * Returns parsed JSON. With `cacheMs`, an identical call within that time is
 * answered from memory; treat the result as read-only.
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

  const reqInit: RequestInit = { method, body };
  let outcome = await attempt(path, reqInit, await getSession());
  if (outcome.kind === "rejected") {
    console.error(`[woolworths] ${outcome.status === 403 ? "403" : "bot-check page"} on ${path}, refreshing cookies`);
    outcome = await attempt(path, reqInit, await getSession(true));
  }
  if (outcome.kind === "rejected") {
    blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
    console.error(`[woolworths] still rejected after a cookie refresh; pausing calls for ${BLOCK_COOLDOWN_MS / 1000}s`);
    throw new WoolworthsError(RATE_LIMITED, 429);
  }

  if (init.cacheMs) remember(key, outcome.value, init.cacheMs);
  return outcome.value as T;
}

/** Test seam: replace the browser capture and reset all session, pacing and cache state. */
export function _resetForTests(fake?: () => Promise<Session>, opts: { minSpacingMs?: number } = {}) {
  session = null;
  pending = null;
  lastAttempt = 0;
  lastError = "";
  capture = fake ?? captureSession;
  minSpacingMs = opts.minSpacingMs ?? 0;
  nextStart = 0;
  blockedUntil = 0;
  cache.clear();
}
