import type { Config } from "./config.ts";

export interface ResponseInfo {
  status: number;
  headers: Record<string, string>;
}
export interface LimitPlan {
  resumeAt: number;
  source: "provider" | "poll";
}

const MAX_WAIT_MS = 8 * 86_400_000;
const SUBSCRIPTION_LIMIT = /(?:usage|subscription|session|weekly|monthly|daily|5[- ]?hour|five[- ]hour)[\s\S]{0,60}(?:limit|quota)|(?:limit|quota)[\s\S]{0,60}(?:subscription|usage|session|weekly)|usage_limit_reached|you(?:['’]ve| have) (?:hit|reached) your limit/i;
const NON_RECOVERABLE = /insufficient_quota|credit balance|billing|payment required|invalid.api.key|authentication_error|permission_error/i;

function epoch(value: unknown): number | undefined {
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,13}(?:\.\d+)?$/.test(value))) {
    const n = Number(value);
    return Number.isFinite(n) ? (n < 1e12 ? n * 1_000 : n) : undefined;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const n = Date.parse(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Only parse a structured reset key, never an unrelated timestamp in an error. */
function jsonReset(text: string): number | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    const object: unknown = JSON.parse(text.slice(start));
    const visit = (value: unknown, depth: number): number | undefined => {
      if (!value || typeof value !== "object" || depth > 6) return undefined;
      for (const [key, child] of Object.entries(value)) {
        if (/^(?:resets?_at|reset_time|reset_timestamp)$/.test(key)) {
          const result = epoch(child);
          if (result !== undefined) return result;
        }
      }
      for (const child of Object.values(value)) {
        const result = visit(child, depth + 1);
        if (result !== undefined) return result;
      }
      return undefined;
    };
    return visit(object, 0);
  } catch {
    return undefined;
  }
}

/** Find the next wall-clock reset; explicit IANA zones respect DST. */
function clockReset(text: string, now: number): number | undefined {
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\)|\s+(UTC|GMT))?/i.exec(text);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return undefined;
  if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  const zone = match[4] ?? match[5];
  // A time with neither minutes nor am/pm is too ambiguous (e.g. "resets 2027").
  if (!match[2] && !meridiem) return undefined;
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const first = Math.floor(now / 60_000) * 60_000;
    // Covers DST fall-back and date changes without guessing a fixed UTC offset.
    for (let offset = 0; offset <= 26 * 60; offset++) {
      const candidate = first + offset * 60_000;
      if (candidate < now) continue;
      const parts = formatter.formatToParts(candidate);
      if (Number(parts.find(p => p.type === "hour")?.value) === hour &&
          Number(parts.find(p => p.type === "minute")?.value) === minute) return candidate;
    }
  } catch {
    // Unknown/ambiguous zone: fall back to polling instead of guessing.
  }
  return undefined;
}

function textReset(text: string, now: number): number | undefined {
  const structured = jsonReset(text);
  if (structured !== undefined) return structured;
  const absolute = /(?:resets? (?:at|on)|try again (?:at|after))\s+(\d{4}-\d{2}-\d{2}T[^\s"}]+)/i.exec(text);
  if (absolute) return epoch(absolute[1]);
  const duration = /(?:try again|resets?|retry)\s+(?:in|after)\s*~?\s*((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/i.exec(text);
  if (duration) {
    let ms = 0;
    for (const part of duration[1].matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi)) {
      ms += Number(part[1]) * (/^h/i.test(part[2]) ? 3_600_000 : /^m/i.test(part[2]) ? 60_000 : 1_000);
    }
    return now + ms;
  }
  return clockReset(text, now);
}

function headerReset(headers: Record<string, string>, now: number): number | undefined {
  const resets: number[] = [];
  for (const window of ["5h", "7d"]) {
    const prefix = `anthropic-ratelimit-unified-${window}`;
    if (headers[`${prefix}-status`] === "rejected") {
      const reset = epoch(headers[`${prefix}-reset`]);
      if (reset !== undefined) resets.push(reset);
    }
  }
  if (resets.length) return Math.max(...resets); // Both blocked windows must reopen.
  const unified = epoch(headers["anthropic-ratelimit-unified-reset"]);
  if (unified !== undefined) return unified;
  const retryAfter = headers["retry-after"];
  if (retryAfter !== undefined) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return now + Number(retryAfter) * 1_000;
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Only subscription failures qualify; ordinary API 429s and billing errors do not. */
export function planLimit(options: {
  provider: string;
  oauth: boolean;
  error: string;
  response?: ResponseInfo;
  now: number;
  config: Config;
}): LimitPlan | undefined {
  const { provider, oauth, error, now, config } = options;
  if (!oauth || !["anthropic", "openai-codex"].includes(provider) || NON_RECOVERABLE.test(error)) return undefined;
  const headers = Object.fromEntries(Object.entries(options.response?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const rejected = provider === "anthropic" && options.response?.status === 429 &&
    Object.entries(headers).some(([key, value]) => /^anthropic-ratelimit-unified(?:-5h|-7d)?-status$/.test(key) && value === "rejected");
  // Anthropic does not distinguish OAuth subscription exhaustion from an account
  // rate limit in its error body, and Pi 1.0.4 drops headers on HTTP failures.
  // Recognize this specific account-level wording only for authenticated OAuth.
  const oauthAccountLimit = provider === "anthropic" && /429|rate_limit_error/i.test(error) &&
    /(?:exceed|exceeded)[\s\S]{0,40}account['’]s rate limit/i.test(error);
  if (!SUBSCRIPTION_LIMIT.test(error) && !rejected && !oauthAccountLimit) return undefined;
  const reset = headerReset(headers, now) ?? textReset(error, now);
  if (reset !== undefined && reset >= now && reset - now <= MAX_WAIT_MS) {
    return { resumeAt: Math.max(reset + config.bufferMs, now + 1_000), source: "provider" };
  }
  return { resumeAt: now + config.pollMs, source: "poll" };
}
