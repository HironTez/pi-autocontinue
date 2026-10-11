import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { waitUntil } from "../src/wait.ts";
import { continuationEntries, createSdk, quotaError, simulateResponses } from "./sdk-helpers.ts";

for (const retryEnabled of [false, true]) {
  test(`real SDK waits then resumes once (built-in retry ${retryEnabled ? "on" : "off"})`, { timeout: 10_000 }, async t => {
    let waits = 0;
    const session = await createSdk(t, {
      retryEnabled,
      dependencies: {
        wait: async (_deadline, signal) => {
          assert.equal(signal.aborted, false);
          assert.ok(session.agent.signal, "wait must run while abort signal is active");
          waits++;
          return true;
        },
      },
    });
    const responses = simulateResponses(session, call => call === 1 ? quotaError : undefined);
    await session.prompt("Complete the task.");
    assert.equal(waits, 1);
    assert.equal(responses.calls, 2, "no duplicate continuation after built-in recovery");
    assert.equal(session.getLastAssistantText(), "Task completed.");
    assert.equal(session.agent.signal, undefined);
  });

  test(`real SDK repeated quota errors exhaust wait budget (built-in retry ${retryEnabled ? "on" : "off"})`, { timeout: 10_000 }, async t => {
    let waits = 0;
    const session = await createSdk(t, {
      retryEnabled,
      dependencies: {
        config: { ...loadConfig({}), maxAttempts: 3 },
        wait: async (_deadline, signal) => {
          assert.equal(signal.aborted, false);
          assert.ok(session.agent.signal);
          waits++;
          return true;
        },
      },
    });
    const retries: number[] = [];
    const exhausted: number[] = [];
    const unsubscribe = session.subscribe(event => {
      if (event.type === "auto_retry_start") retries.push(event.attempt);
      if (event.type === "auto_retry_end" && !event.success) exhausted.push(event.attempt);
    });
    t.after(unsubscribe);
    const responses = simulateResponses(session, () => quotaError);
    await session.prompt("Complete the task.");
    assert.equal(waits, 3);
    assert.equal(responses.calls, 4);
    assert.deepEqual(retries, retryEnabled ? [1, 1] : []);
    assert.deepEqual(exhausted, retryEnabled ? [1, 1] : []);
    assert.equal(continuationEntries(session).length, retryEnabled ? 1 : 3,
      "extension continuation occurs only after built-in recovery exhausts");
    assert.equal(session.isStreaming, false);
    assert.equal(session.agent.signal, undefined);
    // A fresh user task resets the extension's budget.
    await session.prompt("Try a new task.");
    assert.equal(waits, 6);
    assert.equal(responses.calls, 8);
  });
}

test("real SDK abort wakes subscription wait without resuming", { timeout: 10_000 }, async t => {
  const started = Promise.withResolvers<void>();
  let waitSignal: AbortSignal | undefined;
  const session = await createSdk(t, {
    retryEnabled: true,
    dependencies: {
      wait: (deadline, signal, options) => {
        waitSignal = signal;
        started.resolve();
        return waitUntil(deadline, signal, options);
      },
    },
  });
  const responses = simulateResponses(session, () => quotaError);
  const prompt = session.prompt("Complete the task.");
  await started.promise;
  await session.abort();
  await prompt;
  assert.equal(responses.calls, 1);
  assert.equal(session.isStreaming, false);
  assert.equal(getEventListeners(waitSignal!, "abort").length, 0);
});

for (const streamingBehavior of ["steer", "followUp"] as const) {
  test(`real SDK queued ${streamingBehavior} input wakes active wait without stale continuation`, { timeout: 10_000 }, async t => {
    const started = Promise.withResolvers<void>();
    let waits = 0;
    let waitSignal: AbortSignal | undefined;
    const session = await createSdk(t, {
      dependencies: {
        wait: (deadline, signal, options) => {
          waits++;
          waitSignal = signal;
          started.resolve();
          return waitUntil(deadline, signal, options);
        },
      },
    });
    const responses = simulateResponses(session, call => call === 1 ? quotaError : undefined);
    const prompt = session.prompt("Complete the original task.");
    await started.promise;
    await session.prompt("New user task.", { streamingBehavior });
    await prompt;
    assert.equal(waits, 1);
    assert.equal(waitSignal!.aborted, true);
    assert.equal(getEventListeners(waitSignal!, "abort").length, 0);
    assert.equal(responses.calls, 2, "only queued user work, not automatic continuation");
    const userMessages = responses.contexts.at(-1)!.messages.filter(message => message.role === "user");
    assert.ok(userMessages.some(message => JSON.stringify(message.content).includes("New user task.")));
    assert.equal(continuationEntries(session).length, 0);
    assert.equal(session.getLastAssistantText(), "Task completed.");
    assert.equal(session.isStreaming, false);
  });
}

for (const command of ["off", "cancel"]) {
  test(`real SDK /autocontinue ${command} stops active wait and built-in retries`, { timeout: 10_000 }, async t => {
    const started = Promise.withResolvers<void>();
    let waits = 0;
    let waitSignal: AbortSignal | undefined;
    const session = await createSdk(t, {
      retryEnabled: true,
      dependencies: {
        wait: (deadline, signal, options) => {
          waits++;
          if (waits > 1) return Promise.resolve(true);
          waitSignal = signal;
          started.resolve();
          return waitUntil(deadline, signal, options);
        },
      },
    });
    const responses = simulateResponses(session, call => call <= 2 ? quotaError : undefined);
    let retries = 0;
    const unsubscribe = session.subscribe(event => { if (event.type === "auto_retry_start") retries++; });
    t.after(unsubscribe);
    const prompt = session.prompt("Complete the task.");
    await started.promise;
    await session.prompt(`/autocontinue ${command}`);
    await prompt;
    assert.equal(responses.calls, 1);
    assert.equal(retries, 0);
    assert.equal(waitSignal!.aborted, true);
    assert.equal(getEventListeners(waitSignal!, "abort").length, 0);
    assert.equal(continuationEntries(session).length, 0);
    assert.equal(session.isStreaming, false);
    await session.prompt("A fresh task.");
    assert.equal(responses.calls, 3);
    assert.equal(waits, command === "off" ? 1 : 2,
      "off stays disabled, while cancel permits future tasks");
    assert.equal(session.getLastAssistantText(), "Task completed.");
  });
}
