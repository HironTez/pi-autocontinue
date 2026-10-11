# pi-autocontinue

A Pi Agent extension that waits when a subscription usage limit interrupts a task and automatically continues in the **same session** when the window resets.

Supports Anthropic Claude subscription OAuth and OpenAI Codex/ChatGPT OAuth. Requires Node.js **22.19+** (Pi 1.0.4's minimum) and `@earendil-works/pi-coding-agent` **>=1.0.4**. **Tested with Pi 1.0.4**; newer hosts and the older `@badlogic` distribution are untested. The required host contracts are awaited `agent_end` with a live `ctx.signal`, the actionable `agent_before_settle` boundary after built-in recovery, and OAuth detection through the model registry. A version range is not a guarantee that untested hosts preserve these contracts.

## Try it

From this directory:

```sh
pi -e ./src/index.ts
```

Or install this local package persistently:

```sh
pi install .
```

Or install from [GitHub](https://github.com/HironTez/pi-autocontinue):

```sh
pi install git:github.com/HironTez/pi-autocontinue
```

Restart Pi or run `/reload` after installation. **This project is not published to npm.** Once the publisher actually releases it to npm under the intended package name, the installation command will be:

```sh
pi install npm:pi-autocontinue
```

Until then, use the local or GitHub commands above; npm package-name availability has not been verified.

Auto-continue is **on by default**. Continue using Pi normally; no special prompt is required. Loading the extension does not change Pi's permission rules, subscription plan, provider, or model.

## How it works

1. Recognizes finalized **assistant errors**, not text written by a model, user, or tool.
2. Uses an advertised reset time plus a 5-second safety buffer when available. Understands reset timestamps, structured `resets_at`, `Retry-After`, relative durations, and wall-clock times with IANA zones.
3. If the provider supplies no usable reset time, waits **5 minutes** before retrying. Polling continues up to **72 waits** per task by default.
4. Lets Pi's own retry/recovery run first after the wait. If Pi would otherwise stop, requests one continuation through `agent_before_settle`. Existing conversation, completed tool results, and files are retained. A hidden context message is added only when Pi requires one to make continuation valid.

The wait is inside an awaited `agent_end` handler while Pi's abort signal is alive. This keeps print/JSON/RPC requests open as well as interactive sessions. Timers are abortable and cleaned up; there are no background daemons or periodic jobs.

### Important provider limitation

In Pi 1.0.4, the Anthropic SDK throws on HTTP 429 **before** `after_provider_response` is emitted. Pi retains the error text but drops the failed response's reset headers. The extension therefore normally uses polling for Claude subscription errors; it cannot promise resumption at the exact reset second. It does not patch Pi internals, intercept credentials, or query private usage endpoints.

Anthropic sometimes reports subscription exhaustion using the generic wording `This request would exceed your account's rate limit`. That specific error is eligible **only with OAuth**. The reported `account's monthly spend limit` wording also qualifies and polls without usable reset metadata; it is not treated as a hard credit/billing failure. Explicit `insufficient_quota`, credit-balance, billing, payment-required, and authentication errors remain excluded. API-key accounts and other providers are also excluded.

Detection deliberately retains a wording ambiguity: an OAuth account rate limit can be short-lived, and the generic usage-limit matcher also accepts **usage-labelled requests-per-minute** errors (for example, `Usage limit: requests per minute exceeded`). Ordinary throughput errors without qualifying usage/subscription wording or rejected subscription headers do not qualify. Provider text does not reliably separate these cases. Pi's normal built-in retries remain independent.

Reset metadata is best-effort. Stale, malformed, or more-than-eight-day-away timestamps fall back to polling. Times without a zone use the machine's local timezone; unknown named zones fall back to polling. A retry may still encounter a limit, in which case another bounded wait is scheduled.

## Controls

| Command | Effect |
| --- | --- |
| `/autocontinue` or `/autocontinue status` | Show enabled state, deadline, and wait count |
| `/autocontinue off` | Disable automatic continuation for this extension instance; stop an active wait |
| `/autocontinue on` | Enable it for future limit errors; reset the wait budget |
| `/autocontinue cancel` | Cancel this run's wait without disabling future tasks |
| **Esc** | Pi's normal abort cancels the active wait immediately |

New user input, session navigation/shutdown, and model selection cancel the extension's pending continuation. They do not change Pi's separate handling of user queues or built-in retries. Commands changing enabled state are in-memory; `/reload` or a restart restores the startup configuration. Turning it on after an already-settled error does not resurrect a task: send a new prompt such as `Continue`.

The footer shows the countdown in interactive mode. RPC can receive notifications/status messages. Print/JSON mode does not have a visible footer, but still waits and resumes.

## Configuration

Set environment variables **before starting Pi**:

| Variable | Default | Allowed values |
| --- | --- | --- |
| `PI_AUTOCONTINUE_ENABLED` | `true` | `true`, `false`, `1`, `0` |
| `PI_AUTOCONTINUE_POLL_MS` | `300000` | Integer 1000–86400000 |
| `PI_AUTOCONTINUE_BUFFER_MS` | `5000` | Integer 0–60000 |
| `PI_AUTOCONTINUE_MAX_ATTEMPTS` | `72` | Integer 1–1000 |

For example, poll every ten minutes with a larger budget:

```sh
PI_AUTOCONTINUE_POLL_MS=600000 PI_AUTOCONTINUE_MAX_ATTEMPTS=144 pi -e ./src/index.ts
```

The `--autocontinue` boolean extension flag overrides the enabled default. Environment variables are the simplest way to start disabled:

```sh
PI_AUTOCONTINUE_ENABLED=false pi -e ./src/index.ts
```

Invalid configuration fails extension loading instead of producing rapid retry loops. The attempt limit counts scheduled waits, including waits preceding Pi's own retries; it does not cap Pi's independent built-in retries. A new user task gets a new budget.

## Boundaries and safety

- **Keep Pi running.** Closing Pi, reloading extensions, switching sessions, or suspending/terminating the process does not create an external wake-up job. After exiting, resume the session manually and send `Continue`.
- A resumed agent can execute the next actions in the original task, subject to **all existing permission and safety controls**. Use unattended execution only for tasks you are comfortable letting continue later.
- This does not bypass subscription limits, buy credits, rotate accounts, or switch to a paid API key.
- The extension cannot detect quota failures that a custom provider reports only as ordinary successful text, or whose error wording it does not recognize.
- Long provider-advertised waits can last days. Cancellation remains available. When metadata is missing, the default budget covers roughly six hours of polling; increase the budget for longer windows.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

Tests cover detection (including the preserved wording ambiguities), reset parsing and DST, configuration/flag precedence, scheduler clock changes, timer/listener cleanup, callback errors, and duplicate-resumption prevention. Shared SDK fixtures simulate failures using Pi's actual event loop: built-in retry and extension wait-budget exhaustion, queued user input, abort, and off/cancel commands during real waits. SDK cases have bounded timeouts and release resources on failure. No account credentials, remote model calls, or actual subscription exhaustion are required.

### Contributor and release checklist

- Run `npm ci --ignore-scripts`, then `npm run check` (types and tests).
- Run `npm pack --dry-run` and inspect the file list: source, README, license, and package manifest only. `prepack` runs `npm run check` to guard packaging and publication; do not bypass it with `--ignore-scripts` when packing/releasing from this checkout.
- Keep Pi host packages as peers/devDependencies, not runtime dependencies; preserve `src/index.ts` as the extension entry point.
- Before any release, the publisher must verify the intended npm name/account ownership, supply genuine author metadata, confirm the repository/bugs links, review the license/version, and choose the release/tag policy.
- Tags and npm publication are **manual future publisher steps**. Connecting the GitHub repository does not register an npm name or publish a package.

Entry point: [`src/index.ts`](src/index.ts). Limit detection: [`src/limits.ts`](src/limits.ts). Abortable scheduler: [`src/wait.ts`](src/wait.ts).

MIT licensed.
