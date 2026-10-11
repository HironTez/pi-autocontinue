export interface WaitOptions {
  now?: () => number;
  tickMs?: number;
  onTick?: (remainingMs: number) => void;
}

/** Bounded ticks also avoid Node's ~24-day timeout overflow and track clock changes. */
export function waitUntil(deadline: number, signal: AbortSignal, options: WaitOptions = {}): Promise<boolean> {
  const now = options.now ?? Date.now;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    function cleanup(): boolean {
      if (finished) return false;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      return true;
    }
    function finish(completed: boolean) {
      if (cleanup()) resolve(completed);
    }
    function abort() { finish(false); }
    function tick() {
      if (finished) return;
      if (signal.aborted) return finish(false);
      try {
        const remaining = deadline - now();
        if (remaining <= 0) return finish(true);
        options.onTick?.(remaining);
        // A callback may synchronously abort; never schedule after cleanup.
        if (finished || signal.aborted) return finish(false);
        timer = setTimeout(tick, Math.min(remaining, options.tickMs ?? 1_000));
      } catch (error) {
        // Timer callbacks run outside the Promise executor, so reject explicitly.
        if (cleanup()) reject(error);
      }
    }
    signal.addEventListener("abort", abort, { once: true });
    tick();
  });
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
