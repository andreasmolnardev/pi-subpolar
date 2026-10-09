import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const forbiddenDependency = /subpolar-agent|(?:^|[/_-])server(?:[/.-]|$)|react|pocketbase|hono|core-pi|pi-coding-agent/i;

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

for (const name of ["subpolar-contracts", "subpolar-core"]) {
  test(`${name} package has no server, React, PocketBase, or Pi dependencies`, async () => {
    const manifestPath = fileURLToPath(new URL(`../../${name}/package.json`, import.meta.url));
    const manifest = await Bun.file(manifestPath).json();
    const dependencies = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((section) => Object.keys(manifest[section] ?? {}));
    expect(dependencies.some((dependency) => forbiddenDependency.test(dependency))).toBe(false);

    const cwd = fileURLToPath(new URL(`../../${name}/src/`, import.meta.url));
    for await (const path of new Bun.Glob("**/*.ts").scan(cwd)) {
      const source = await Bun.file(`${cwd}/${path}`).text();
      const imports = source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g);
      for (const [, specifier] of imports) expect(specifier).not.toMatch(forbiddenDependency);
    }
  });
}
