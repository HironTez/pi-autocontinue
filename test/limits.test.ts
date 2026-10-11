import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { planLimit, type ResponseInfo } from "../src/limits.ts";

const config = loadConfig({});
const now = Date.parse("2026-07-19T12:00:00Z");
function plan(error = "You have hit your usage limit", response?: ResponseInfo, provider = "anthropic", oauth = true) {
  return planLimit({ provider, oauth, error, response, now, config });
}

test("safe configuration defaults and validation", () => {
  assert.deepEqual(config, { enabled: true, pollMs: 300_000, bufferMs: 5_000, maxAttempts: 72 });
  assert.equal(loadConfig({ PI_AUTOCONTINUE_ENABLED: "false" }).enabled, false);
  assert.equal(loadConfig({ PI_AUTOCONTINUE_BUFFER_MS: "0" }).bufferMs, 0);
  for (const value of ["no", "NaN", "0", "-1", "1.5", "Infinity", ""]) {
    assert.throws(() => loadConfig({ PI_AUTOCONTINUE_POLL_MS: value }));
  }
  assert.throws(() => loadConfig({ PI_AUTOCONTINUE_ENABLED: "yes" }));
});

test("ignores API keys, other providers, ordinary throughput, billing and unrelated errors", () => {
  assert.equal(plan(undefined, undefined, "anthropic", false), undefined);
  assert.equal(plan(undefined, undefined, "openai", true), undefined);
  for (const error of [
    "429 rate_limit_error: requests per minute exceeded. Please try again later.",
    "Overloaded", "context window exceeded", "network error", "401 authentication_error",
    "usage limit: insufficient_quota", "usage limit: credit balance is too low", "usage limit: billing error",
  ]) assert.equal(plan(error), undefined, error);
});

test("usage-labelled requests-per-minute wording retains current polling ambiguity", () => {
  const error = "Usage limit: requests per minute exceeded. Please try again later.";
  assert.deepEqual(plan(error), { resumeAt: now + config.pollMs, source: "poll" });
  assert.deepEqual(plan(error, undefined, "openai-codex"), { resumeAt: now + config.pollMs, source: "poll" });
  assert.equal(plan(error, undefined, "anthropic", false), undefined);
});

test("subscription limit without metadata uses bounded polling", () => {
  for (const error of ["You've hit your limit", "You’ve hit your limit", "Session limit reached", "Weekly quota exceeded", "usage_limit_reached"]) {
    assert.deepEqual(plan(error), { resumeAt: now + config.pollMs, source: "poll" });
  }
});

test("actual Anthropic OAuth account-limit errors poll when failure headers are unavailable", () => {
  const error = `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}`;
  assert.deepEqual(plan(error), { resumeAt: now + config.pollMs, source: "poll" });
  assert.equal(plan(error, undefined, "anthropic", false), undefined);
  assert.equal(plan(error, undefined, "openai-codex"), undefined);
  assert.equal(plan("429 rate_limit_error: This request would exceed your account's monthly spend limit. Please try again later.")?.source, "poll");
});

test("Anthropic rejected unified headers identify otherwise generic OAuth 429", () => {
  const error = "This request would exceed your account's rate limit";
  assert.deepEqual(plan(error, { status: 429, headers: {
    "Anthropic-RateLimit-Unified-Status": "rejected",
    "Anthropic-RateLimit-Unified-Reset": String((now + 3_600_000) / 1_000),
  } }), { resumeAt: now + 3_605_000, source: "provider" });
  assert.equal(plan("429 requests per minute exceeded", { status: 200, headers: { "anthropic-ratelimit-unified-status": "rejected" } }), undefined);
  assert.equal(plan("429 requests per minute exceeded", { status: 429, headers: { "anthropic-ratelimit-unified-status": "allowed" } }), undefined);
});

test("waits for every rejected window, not for an allowed window", () => {
  assert.equal(plan(undefined, { status: 429, headers: {
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String((now + 3_600_000) / 1_000),
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String((now + 86_400_000) / 1_000),
  } })?.resumeAt, now + 86_405_000);
  assert.equal(plan(undefined, { status: 429, headers: {
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String((now + 3_600_000) / 1_000),
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-reset": String((now + 86_400_000) / 1_000),
  } })?.resumeAt, now + 3_605_000);
});

test("Retry-After seconds/date, only for a positively identified subscription error", () => {
  assert.equal(plan(undefined, { status: 429, headers: { "retry-after": "120" } })?.resumeAt, now + 125_000);
  assert.equal(plan(undefined, { status: 429, headers: { "retry-after": "Sun, 19 Jul 2026 13:00:00 GMT" } })?.resumeAt, now + 3_605_000);
  assert.equal(plan("429 rate limit", { status: 429, headers: { "retry-after": "120" } }), undefined);
});

test("nested JSON epoch seconds/milliseconds/ISO and HTTP status prefix", () => {
  for (const timestamp of [(now + 3_600_000) / 1_000, now + 3_600_000, "2026-07-19T13:00:00Z"]) {
    assert.equal(plan(`429 ${JSON.stringify({ error: { type: "usage_limit_reached", resets_at: timestamp } })}`)?.resumeAt, now + 3_605_000);
  }
});

test("Codex rendered duration, composite intervals and ISO reset", () => {
  assert.equal(plan("You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.", undefined, "openai-codex")?.resumeAt, now + 42 * 60_000 + 5_000);
  assert.equal(plan("Usage limit reached. Try again in 1h 30m 5s")?.resumeAt, now + 5_410_000);
  assert.equal(plan("Usage limit reached. Resets at 2026-07-19T13:00:00Z")?.resumeAt, now + 3_605_000);
});

test("wall-clock resets handle IANA zones, UTC, midnight and invalid zones", () => {
  assert.equal(plan("You've hit your limit · resets 3pm (Europe/London)")?.resumeAt, now + 2 * 3_600_000 + 5_000);
  assert.equal(plan("You've hit your limit · resets 1:30pm UTC")?.resumeAt, now + 90 * 60_000 + 5_000);
  assert.equal(plan("You've hit your limit · resets 12am (UTC)")?.resumeAt, now + 12 * 3_600_000 + 5_000);
  assert.equal(plan("You've hit your limit · resets 3pm (Bad/Zone)")?.source, "poll");
  assert.equal(plan("You've hit your limit · resets 99:99")?.source, "poll");
});

test("IANA wall-clock resets handle DST gaps and both occurrences of repeated hours", () => {
  for (const [current, clock, expected] of [
    ["2026-03-08T06:55:00Z", "3am", "2026-03-08T07:00:00Z"],
    // The skipped 2:30am is not guessed: use its next real occurrence.
    ["2026-03-08T06:55:00Z", "2:30am", "2026-03-09T06:30:00Z"],
    ["2026-11-01T05:15:00Z", "1:30am", "2026-11-01T05:30:00Z"],
    ["2026-11-01T05:45:00Z", "1:30am", "2026-11-01T06:30:00Z"],
  ]) {
    assert.deepEqual(planLimit({
      provider: "anthropic", oauth: true,
      error: `You've hit your limit · resets ${clock} (America/New_York)`,
      now: Date.parse(current!), config,
    }), { resumeAt: Date.parse(expected!) + config.bufferMs, source: "provider" });
  }
});

test("stale, malformed and implausibly distant reset times fall back to polling", () => {
  for (const reset of [now - 60_000, now + 9 * 86_400_000, "oops"]) {
    assert.deepEqual(plan(`{"error":{"type":"usage_limit_reached","resets_at":${JSON.stringify(reset)}}}`), { resumeAt: now + 300_000, source: "poll" });
  }
  assert.equal(plan('Usage limit reached {bad json}')?.source, "poll");
});
