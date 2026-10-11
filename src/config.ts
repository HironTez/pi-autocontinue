export interface Config {
  enabled: boolean;
  pollMs: number;
  bufferMs: number;
  maxAttempts: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  function number(name: string, fallback: number, min: number, max: number): number {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  }
  const enabled = env.PI_AUTOCONTINUE_ENABLED ?? "true";
  if (!["true", "false", "1", "0"].includes(enabled)) {
    throw new Error("PI_AUTOCONTINUE_ENABLED must be true, false, 1, or 0");
  }
  return {
    enabled: enabled === "true" || enabled === "1",
    pollMs: number("PI_AUTOCONTINUE_POLL_MS", 300_000, 1_000, 86_400_000),
    bufferMs: number("PI_AUTOCONTINUE_BUFFER_MS", 5_000, 0, 60_000),
    maxAttempts: number("PI_AUTOCONTINUE_MAX_ATTEMPTS", 72, 1, 1_000),
  };
}
