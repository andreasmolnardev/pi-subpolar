import { expect, test } from "bun:test";

test("core source has no runtime imports from Pi, WebUI, PocketBase, or HTTP", async () => {
  const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:pi|webui|pocketbase|hono)[^"']*["']/i);
});
