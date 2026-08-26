import { describe, expect, it } from "vitest";
import { buildConfig, InvalidFlagError } from "../../src/cli/commands/run.ts";
import type { CliFlags } from "../../src/cli/index.ts";

/**
 * The numeric flags feed setTimeout and the worker pool directly, where NaN is not
 * inert: `setTimeout(fn, NaN)` fires on the next tick, and `Array.from({length: NaN})`
 * builds an empty pool that does nothing and reports success. Bad input has to be
 * rejected at the boundary rather than coerced.
 */
describe("numeric flag validation", () => {
  const bad: [keyof CliFlags, string][] = [
    ["concurrency", "abc"],
    ["concurrency", "0"],
    ["concurrency", "-1"],
    ["timeout", "abc"],
    ["login-timeout", "abc"],
    ["max-attempts", "0"],
    ["retry-backoff", "nope"],
    ["stall-timeout", "-5"],
  ];

  it.each(bad)("rejects --%s %s", (flag, value) => {
    expect(() => buildConfig({ [flag]: value } as CliFlags)).toThrow(
      InvalidFlagError,
    );
  });

  it("names the offending flag and value", () => {
    expect(() => buildConfig({ concurrency: "abc" } as CliFlags)).toThrow(
      /--concurrency.*"abc"/,
    );
  });

  it("accepts positive numbers and converts seconds to ms", () => {
    const cfg = buildConfig({
      concurrency: "3",
      timeout: "60",
      "login-timeout": "30",
      "max-attempts": "2",
      "retry-backoff": "5",
    } as CliFlags);

    expect(cfg.concurrency).toBe(3);
    expect(cfg.timeoutMs).toBe(60_000);
    expect(cfg.loginTimeoutMs).toBe(30_000);
    expect(cfg.maxAttempts).toBe(2);
    expect(cfg.retryBackoffMs).toBe(5_000);
  });
});
