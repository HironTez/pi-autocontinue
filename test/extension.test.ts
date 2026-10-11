import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentBeforeSettleEventResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { install, type Dependencies } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";
import { waitUntil } from "../src/wait.ts";

// Minimal event host; the separate SDK integration test exercises real lifecycle ordering.
function harness(dependencies: Dependencies = {}, options: { flag?: boolean; signal?: boolean } = {}) {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, RegisteredCommand["handler"]>();
  const abortController = new AbortController();
  const waits: number[] = [];
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  let pending = false;
  let oauth = true;
  const ctx = {
    signal: options.signal === false ? undefined : abortController.signal,
    model: { id: "claude", provider: "anthropic" },
    modelRegistry: { isUsingOAuth: () => oauth },
    hasPendingMessages: () => pending,
    abort: () => abortController.abort(),
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
    registerCommand: (name: string, command: Pick<RegisteredCommand, "handler">) => commands.set(name, command.handler),
    registerFlag: () => {},
    getFlag: () => options.flag,
  } as unknown as ExtensionAPI;
  install(pi, {
    config: loadConfig({}), now: () => 1_000_000,
    wait: async (deadline, signal, options) => {
      waits.push(deadline);
      options?.onTick?.(deadline - 1_000_000);
      return !signal.aborted;
    },
    ...dependencies,
  });
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const command = (arg: string) => commands.get("autocontinue")!(arg, ctx as ExtensionCommandContext);
  const end = (error = "Session usage limit reached") => emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "error", errorMessage: error }],
  });
  const settle = (canContinue = false, outcome = "error") => emit("agent_before_settle", {
    outcome, context: { canContinue },
  }) as AgentBeforeSettleEventResult | undefined;
  return {
    emit, command, end, settle, waits, notices, statuses, abortController,
    setPending: (value: boolean) => { pending = value; },
    setOauth: (value: boolean) => { oauth = value; },
  };
}

test("waits and requests exactly one supported boundary continuation", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.end();
  assert.deepEqual(h.waits, [1_300_000]);
  const result = h.settle();
  assert.ok(result);
  assert.equal(result.continue, true);
  const entry = result.entries?.[0];
  assert.ok(entry);
  assert.equal(entry.type, "custom_message");
  assert.ok("display" in entry);
  assert.equal(entry.display, false);
  assert.equal(h.settle(), undefined);
  assert.equal(h.statuses.at(-1), undefined);
});

test("does not add context when boundary already allows continuation", async () => {
  const h = harness();
  await h.end();
  assert.deepEqual(h.settle(true), { continue: true });
});

test("built-in retry has priority and success does not trigger a duplicate run", async () => {
  const h = harness();
  await h.end();
  await h.emit("turn_start");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(h.settle(false, "completed"), undefined);
  assert.equal(h.waits.length, 1);
});

test("ignores normal completion, generic errors, aborted messages and non-OAuth", async () => {
  const h = harness();
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "usage limit" }] });
  await h.end("429 rate_limit_error");
  h.setOauth(false);
  await h.end();
  assert.equal(h.waits.length, 0);
  assert.equal(h.settle(), undefined);
});

test("bounded repeated limits; new user task resets budget", async () => {
  const h = harness({ config: { ...loadConfig({}), maxAttempts: 2 } });
  for (let i = 0; i < 2; i++) {
    await h.emit("turn_start");
    await h.end();
    assert.equal(h.settle(true)?.continue, true);
  }
  await h.end();
  assert.equal(h.waits.length, 2);
  assert.equal(h.settle(), undefined);
  assert.match(h.notices.at(-1)!, /stopped after 2 waits/);
  await h.emit("before_agent_start");
  await h.end();
  assert.equal(h.waits.length, 3);
});

test("response metadata is cleared for each new turn", async () => {
  const h = harness();
  await h.emit("after_provider_response", { status: 429, headers: { "retry-after": "3600" } });
  await h.end();
  assert.equal(h.waits[0], 4_605_000);
  await h.emit("turn_start");
  await h.end();
  assert.equal(h.waits[1], 1_300_000);
});

test("pending input prevents waits and continuation", async () => {
  const h = harness();
  h.setPending(true);
  await h.end();
  assert.equal(h.waits.length, 0);
  h.setPending(false);
  await h.end();
  h.setPending(true);
  assert.equal(h.settle(), undefined);
});

test("commands disable, re-enable and report status", async () => {
  const h = harness();
  await h.command(" OFF ");
  await h.end();
  assert.equal(h.waits.length, 0);
  await h.command(" ON ");
  await h.end();
  assert.equal(h.waits.length, 1);
  await h.command("status");
  assert.match(h.notices.at(-1)!, /Auto-continue on/);
  await h.command("unknown");
  assert.match(h.notices.at(-1)!, /Usage:/);
});

test("Esc abort wakes a long wait immediately", async () => {
  const h = harness({ wait: waitUntil, now: Date.now });
  const waiting = h.end();
  h.abortController.abort();
  await waiting;
  assert.equal(h.settle(), undefined);
  assert.equal(h.statuses.at(-1), undefined);
});

for (const name of ["session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "model_select", "input"]) {
  test(`${name} cancels active wait and stale continuation`, async () => {
    const h = harness({ wait: waitUntil, now: Date.now });
    const waiting = h.end();
    await h.emit(name);
    await waiting;
    assert.equal(h.settle(), undefined);
    assert.equal(h.statuses.at(-1), undefined);
  });
}

test("cancel command stops Pi's active run as well as the timer", async () => {
  const h = harness({ wait: waitUntil, now: Date.now });
  const waiting = h.end();
  await h.command("cancel");
  await waiting;
  assert.equal(h.abortController.signal.aborted, true);
  assert.equal(h.settle(), undefined);
});

test("an aborted operation signal never creates a timer", async () => {
  const h = harness();
  h.abortController.abort();
  await h.end();
  assert.equal(h.waits.length, 0);
});

test("an absent operation signal never creates a timer", async () => {
  const h = harness({}, { signal: false });
  await h.end();
  assert.equal(h.waits.length, 0);
  assert.equal(h.settle(), undefined);
});

for (const options of [
  { enabled: false, flag: undefined },
  { enabled: true, flag: false },
  { enabled: false, flag: true },
]) {
  test(`startup enabled=${options.enabled}, flag=${options.flag} honors flag precedence`, async () => {
    const h = harness({ config: { ...loadConfig({}), enabled: options.enabled } }, { flag: options.flag });
    await h.emit("session_start");
    await h.end();
    assert.equal(h.waits.length, (options.flag ?? options.enabled) ? 1 : 0);
    if (!(options.flag ?? options.enabled)) assert.equal(h.settle(), undefined);
  });
}
