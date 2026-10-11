import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { install, type Dependencies } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";

export const quotaError = `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}`;
type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

/** Isolated real SDK lifecycle, with no account credentials or remote model calls. */
export async function createSdk(t: TestContext, options: {
  retryEnabled?: boolean;
  dependencies?: Dependencies;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-autocontinue-test-"));
  let session: Session | undefined;
  const extensionErrors: unknown[] = [];
  const abort = () => { void session?.abort().catch(error => extensionErrors.push(error)); };
  t.signal.addEventListener("abort", abort, { once: true });
  // Register cleanup before setup: failed assertions and partial setup still release resources.
  t.after(async () => {
    try {
      await session?.abort();
      assert.deepEqual(extensionErrors, []);
    } finally {
      t.signal.removeEventListener("abort", abort);
      session?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: options.retryEnabled ?? false, maxRetries: 1, baseDelayMs: 1 },
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("anthropic", "test-only-no-network");
  runtime.isUsingOAuth = () => true;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Test assistant.",
    extensionFactories: [pi => install(pi, { config: loadConfig({}), ...options.dependencies })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime,
    model: getModel("anthropic", "claude-sonnet-4-5")!, settingsManager: settings,
    sessionManager: SessionManager.inMemory(dir), resourceLoader: loader, tools: [],
  }));
  await session.bindExtensions({ onError: error => extensionErrors.push(error) });
  return session;
}

/** Replaces the model transport only; Pi still owns retries, queues and settlement. */
export function simulateResponses(session: Session, errorForCall: (call: number) => string | undefined) {
  let calls = 0;
  const contexts: Context[] = [];
  session.agent.streamFunction = (model, context) => {
    const error = errorForCall(++calls);
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: error ? [] : [{ type: "text", text: "Task completed." }],
      stopReason: error ? "error" : "stop",
      ...(error ? { errorMessage: error } : {}), timestamp: Date.now(),
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  return { get calls() { return calls; }, contexts };
}

export function continuationEntries(session: Session) {
  return session.sessionManager.getBranch().filter(entry =>
    entry.type === "custom_message" && entry.customType === "pi-autocontinue-resume");
}
