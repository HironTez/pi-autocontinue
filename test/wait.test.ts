import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { duration, waitUntil } from "../src/wait.ts";

test("wait resolves at deadline with countdown", async () => {
  let time = 0;
  const ticks: number[] = [];
  assert.equal(await waitUntil(3, new AbortController().signal, {
    now: () => time++, tickMs: 1, onTick: remaining => ticks.push(remaining),
  }), true);
  assert.deepEqual(ticks, [3, 2, 1]);
});

test("long wait cancels immediately and leaves no timers", async () => {
  const controller = new AbortController();
  const promise = waitUntil(Date.now() + 7 * 86_400_000, controller.signal);
  controller.abort();
  assert.equal(await promise, false);
});

test("already aborted signal does not tick; past deadline finishes immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await waitUntil(100, controller.signal, { now: () => 0, onTick: () => assert.fail() }), false);
  assert.equal(await waitUntil(0, new AbortController().signal, { now: () => 1 }), true);
});

test("synchronous abort from onTick does not schedule a timer or retain a listener", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const schedule = t.mock.method(globalThis, "setTimeout");
  const controller = new AbortController();
  try {
    assert.equal(await waitUntil(100, controller.signal, {
      now: () => 0, onTick: () => controller.abort(),
    }), false);
    assert.equal(schedule.mock.callCount(), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    controller.abort();
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

for (const throwOnTick of [1, 2]) {
  test(`onTick error on tick ${throwOnTick} rejects and cleans up`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const schedule = t.mock.method(globalThis, "setTimeout");
    const clear = t.mock.method(globalThis, "clearTimeout");
    const controller = new AbortController();
    const error = new Error("countdown failed");
    let ticks = 0;
    const promise = waitUntil(100, controller.signal, {
      now: () => 0, tickMs: 10,
      onTick: () => { if (++ticks === throwOnTick) throw error; },
    });
    // Observe rejection before firing the timer, avoiding unhandled rejection reports.
    const rejected = assert.rejects(promise, error);
    try {
      if (throwOnTick === 2) assert.doesNotThrow(() => t.mock.timers.tick(10));
      await rejected;
      assert.equal(schedule.mock.callCount(), throwOnTick - 1);
      assert.equal(clear.mock.callCount(), throwOnTick - 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      t.mock.timers.tick(1_000);
      assert.equal(ticks, throwOnTick);
    } finally {
      controller.abort();
      await rejected.catch(() => {});
      t.mock.restoreAll();
      t.mock.timers.reset();
    }
  });
}

test("scheduler tracks forward and backward clock changes and cleans up at completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const ticks: number[] = [];
  let now = 0;
  try {
    const promise = waitUntil(100, controller.signal, {
      now: () => now, tickMs: 10, onTick: remaining => ticks.push(remaining),
    });
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    now = 50;
    t.mock.timers.tick(10);
    now = -30;
    t.mock.timers.tick(10);
    now = 110;
    t.mock.timers.tick(10);
    assert.equal(await promise, true);
    assert.deepEqual(ticks, [100, 50, 130]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    t.mock.timers.tick(1_000);
    assert.deepEqual(ticks, [100, 50, 130]);
  } finally {
    controller.abort();
    t.mock.timers.reset();
  }
});

test("abort clears the scheduled timer and listener", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = t.mock.method(globalThis, "clearTimeout");
  const controller = new AbortController();
  let ticks = 0;
  try {
    const promise = waitUntil(100, controller.signal, { now: () => 0, onTick: () => ticks++ });
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    controller.abort();
    assert.equal(await promise, false);
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    t.mock.timers.tick(1_000);
    assert.equal(ticks, 1);
  } finally {
    controller.abort();
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

test("formats countdown", () => {
  assert.equal(duration(500), "1s");
  assert.equal(duration(60_000), "1m");
  assert.equal(duration(3_661_000), "1h 2m");
});
