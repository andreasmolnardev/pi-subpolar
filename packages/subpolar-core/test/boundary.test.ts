import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const name of ["subpolar-core", "subpolar-core-pi", "subpolar-cli"]) {
  test(`${name} source has no Subpolar Agent or PocketBase runtime imports`, async () => {
    const cwd = fileURLToPath(new URL(`../../${name}/src/`, import.meta.url));
    for await (const path of new Bun.Glob("**/*.ts").scan(cwd)) {
      const source = await Bun.file(`${cwd}/${path}`).text();
      expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:subpolar-agent|pocketbase|hono)[^"']*["']/i);
      if (name === "subpolar-core") expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:core-pi|pi-coding-agent)[^"']*["']/i);
    }
  });
}
