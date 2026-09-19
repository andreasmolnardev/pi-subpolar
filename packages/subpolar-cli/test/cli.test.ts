import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli.ts";

describe("subpolar-cli", () => {
  test("runs the local fixture with a stable JSON result envelope", async () => {
    const output: string[] = [];
    const exitCode = await runCli(["run", "hello", "world", "--json", "--session", "smoke"], { now: () => new Date("2026-01-01T00:00:00.000Z") }, { stdout: (text) => output.push(text) });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: true, command: "run", sessionId: "smoke", executor: "local-fixture-echo", result: { text: "Local fixture echo: hello world" } });
  });

  test("returns a JSON error and nonzero exit code for an invalid command", async () => {
    const output: string[] = [];
    const exitCode = await runCli(["nope", "--json"], {}, { stdout: (text) => output.push(text) });

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: false, error: { code: "CLI_USAGE_ERROR" } });
  });

  test("sanitizes executor errors returned to the CLI", async () => {
    const output: string[] = [];
    const exitCode = await runCli(
      ["run", "hello", "--json", "--session", "executor-error"],
      {
        executor: async () => {
          throw new Error('provider failed with token=cli-secret');
        },
      },
      { stdout: (text) => output.push(text) },
    );

    expect(exitCode).toBe(1);
    const result = JSON.parse(output.join(""));
    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_FAILED", message: "Tool execution failed" } });
    expect(output.join("")).not.toContain("cli-secret");
  });
});
