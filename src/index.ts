import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Config } from "./config.ts";
import { planLimit, type ResponseInfo } from "./limits.ts";
import { duration, waitUntil } from "./wait.ts";

const STATUS = "pi-autocontinue";
const CONTINUATION = "The subscription usage wait has elapsed. Continue the interrupted task from the existing conversation. Preserve completed work and do not repeat completed actions unnecessarily.";

export interface Dependencies {
  config?: Config;
  now?: () => number;
  wait?: typeof waitUntil;
}

/** Exported separately so scheduling can be tested without a real provider or quota. */
export function install(pi: ExtensionAPI, dependencies: Dependencies = {}) {
  const config = dependencies.config ?? loadConfig(process.env);
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? waitUntil;
  // Enabled is instance-wide; attempts counts scheduled waits in the current task.
  let enabled = config.enabled;
  let attempts = 0;
  // Suppression blocks this run until reset/on; ready is a one-shot elapsed wait.
  let suppressed = false;
  let ready = false;
  let response: ResponseInfo | undefined;
  // At most one awaited agent_end owns a wait; its finally block clears ownership.
  let waiting: { controller: AbortController; resumeAt: number; ctx: ExtensionContext } | undefined;

  function cancel() {
    ready = false;
    suppressed = true;
    waiting?.controller.abort();
    waiting?.ctx.ui.setStatus(STATUS, undefined);
  }
  function reset() {
    cancel();
    suppressed = false;
    attempts = 0;
    response = undefined;
  }

  pi.registerFlag("autocontinue", {
    description: "Automatically resume after subscription usage limits reset",
    type: "boolean",
    default: config.enabled,
  });
  pi.registerCommand("autocontinue", {
    description: "Subscription auto-resume: status, on, off, cancel",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      switch (action) {
        case "on":
          enabled = true;
          suppressed = false;
          attempts = 0;
          ctx.ui.notify("Auto-continue enabled for future subscription limit errors.", "info");
          break;
        case "off":
        case "cancel": {
          if (action === "off") enabled = false;
          const wasWaiting = waiting !== undefined;
          cancel();
          // Abort while the low-level agent run is still active, also stopping Pi's retries.
          if (wasWaiting) ctx.abort();
          ctx.ui.notify(enabled ? "Automatic continuation cancelled for this run." : "Auto-continue disabled.", "info");
          break;
        }
        case "status":
          ctx.ui.notify(`Auto-continue ${enabled ? "on" : "off"}; ${waiting ? `resuming at ${new Date(waiting.resumeAt).toLocaleString()}` : suppressed ? "cancelled for this run" : "not waiting"}; waits ${attempts}/${config.maxAttempts}.`, "info");
          break;
        default:
          ctx.ui.notify("Usage: /autocontinue [status|on|off|cancel]", "warning");
      }
    },
  });

  pi.on("session_start", () => {
    reset();
    enabled = Boolean(pi.getFlag("autocontinue") ?? config.enabled);
  });
  pi.on("before_agent_start", reset);
  pi.on("session_shutdown", cancel);
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("model_select", cancel);
  pi.on("input", () => {
    // An explicit new user request takes precedence over an automatic continuation.
    cancel();
    return { action: "continue" };
  });
  pi.on("turn_start", () => {
    response = undefined;
    ready = false;
  });
  pi.on("after_provider_response", (event) => {
    response = { status: event.status, headers: { ...event.headers } };
  });

  pi.on("agent_end", async (event, ctx) => {
    ready = false;
    if (!enabled || suppressed || waiting || ctx.hasPendingMessages() || !ctx.model) return;
    const message = event.messages.findLast(message => message.role === "assistant");
    if (!message || message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage) {
      attempts = 0;
      return;
    }
    const plan = planLimit({
      provider: ctx.model.provider,
      oauth: ctx.modelRegistry.isUsingOAuth(ctx.model),
      error: message.errorMessage,
      response,
      now: now(),
      config,
    });
    if (!plan) return;
    if (attempts >= config.maxAttempts) {
      suppressed = true;
      ctx.ui.notify(`Auto-continue stopped after ${attempts} waits. Send a new prompt to try again.`, "warning");
      return;
    }
    // agent_end handlers are awaited while the run's abort signal is still alive.
    // Waiting at agent_before_settle instead would lose that signal (Esc could not wake it).
    const signal = ctx.signal;
    if (!signal || signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const current = { controller, resumeAt: plan.resumeAt, ctx };
    waiting = current;
    attempts++;
    try {
      ctx.ui.notify(`Subscription limit reached. ${plan.source === "provider" ? "Resuming" : "No reset time supplied; retrying"} at ${new Date(plan.resumeAt).toLocaleString()}. Esc or /autocontinue cancel stops the wait.`, "warning");
      const elapsed = await wait(plan.resumeAt, controller.signal, {
        now,
        onTick: remaining => ctx.ui.setStatus(STATUS, `Auto-continue in ${duration(remaining)} (${attempts}/${config.maxAttempts})`),
      });
      ready = elapsed && !controller.signal.aborted && enabled && !suppressed && !ctx.hasPendingMessages();
      if (ready) ctx.ui.notify("Subscription wait elapsed; resuming the interrupted task.", "info");
    } finally {
      signal.removeEventListener("abort", abort);
      if (waiting === current) {
        waiting = undefined;
        ctx.ui.setStatus(STATUS, undefined);
      }
    }
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (!ready || !enabled || suppressed || event.outcome !== "error" || ctx.hasPendingMessages()) return;
    ready = false;
    // Let Pi's built-in recovery go first. If it did not retry, use the supported boundary
    // continuation, adding context only when a trailing assistant prevents continuation.
    return {
      continue: true,
      ...(event.context.canContinue ? {} : {
        entries: [{
          type: "custom_message" as const,
          customType: "pi-autocontinue-resume",
          content: CONTINUATION,
          display: false,
        }],
      }),
    };
  });
}

export default function autocontinue(pi: ExtensionAPI) {
  install(pi);
}
