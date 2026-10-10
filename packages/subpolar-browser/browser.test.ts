import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChromiumBrowserPort,
  DEFAULT_BROWSER_LIMITS,
  WorkerBrowserPort,
  startBrowserWorker,
} from "./src/index.ts";
import { publicAddress, createEgressProxy } from "./src/network.ts";
describe("browser network policy", () => {
  test("blocks private, mapped IPv6, metadata and reserved IPs", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
      "2002:7f00:1::",
    ])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
  });
  test("proxy rejects private without trusted administrator exception", async () => {
    const proxy = await createEgressProxy();
    const response = await fetch(proxy.url, { headers: {}, method: "GET" });
    expect(response.status).toBe(403);
    await proxy.close();
  });
  test("worker authenticates and hides internal errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "browser-worker-"));
    const worker = startBrowserWorker({
      profileRoot: root,
      token: "x".repeat(32),
      port: 0,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${worker.server.port}/v1/browser`,
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(401);
      const client = new WorkerBrowserPort(
        `http://127.0.0.1:${worker.server.port}`,
        "x".repeat(32),
      );
      expect(((await client.health()) as any).sessions).toBe(0);
      await expect(client.clearProfile("../escape")).rejects.toThrow(
        "Browser operation failed",
      );
    } finally {
      await worker.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
test("real Chromium interactions persistent state isolation and profile lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-real-"));
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        "<title>Fixture</title><label>Name<input aria-label=\"Name\"></label><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value;localStorage.setItem('name',document.querySelector('input').value)\">Save</button><output></output><script>document.querySelector('output').textContent=localStorage.getItem('name')||'fresh'</script>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const engine = new ChromiumBrowserPort({
    profileRoot: root,
    allowedPrivateHosts: ["127.0.0.1"],
  });
  const url = `http://127.0.0.1:${fixture.port}`;
  try {
    await engine.start("first", { profileId: "profile" });
    await expect(
      engine.start("second", { profileId: "profile" }),
    ).rejects.toThrow("Profile is already leased");
    const tab = await engine.open("first", url, DEFAULT_BROWSER_LIMITS);
    await engine.action(
      "first",
      "fill",
      { locator: { label: "Name" }, value: "Ada" },
      tab.id,
    );
    await engine.action(
      "first",
      "click",
      { locator: { role: "button", name: "Save" } },
      tab.id,
    );
    expect((await engine.read("first", tab.id)).text).toContain("Ada");
    expect(
      ((await engine.action("first", "snapshot", {}, tab.id)) as any).snapshot,
    ).toContain("Save");
    expect(
      Buffer.from((await engine.screenshot("first")).data, "base64")
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
    await engine.close("first");
    await engine.dispose();
    const restarted = new ChromiumBrowserPort({
      profileRoot: root,
      allowedPrivateHosts: ["127.0.0.1"],
    });
    try {
      await restarted.start("new", { profileId: "profile" });
      expect(
        (await restarted.open("new", url, DEFAULT_BROWSER_LIMITS)).text,
      ).toContain("Ada");
      const fresh = await restarted.open(
        "ephemeral",
        url,
        DEFAULT_BROWSER_LIMITS,
      );
      expect(fresh.text).toContain("fresh");
      await restarted.action(
        "new",
        "close-tab",
        {},
        (await restarted.tabs("new"))[0]!.id,
      );
    } finally {
      await restarted.dispose();
    }
  } finally {
    await engine.dispose();
    fixture.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test("real browser network denies private default redirects subresources and unsafe schemes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-policy-"));
  let forbiddenHits = 0;
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const u = new URL(request.url);
      if (u.pathname === "/redirect")
        return Response.redirect(`http://localhost:${fixture.port}/forbidden`);
      if (u.pathname === "/forbidden") {
        forbiddenHits++;
        return new Response("secret internal service");
      }
      return new Response(
        `<title>Policy</title><img src="http://localhost:${fixture.port}/forbidden"><script>fetch('http://localhost:${fixture.port}/forbidden').catch(()=>{})</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const denied = new ChromiumBrowserPort({ profileRoot: root });
  const allowed = new ChromiumBrowserPort({
    profileRoot: root,
    allowedPrivateHosts: ["127.0.0.1"],
  });
  try {
    const url = `http://127.0.0.1:${fixture.port}`;
    const blocked = await denied
      .open("blocked", url, DEFAULT_BROWSER_LIMITS)
      .catch(() => null);
    expect(blocked === null || blocked.status === 403).toBe(true);
    const tab = await allowed.open("allowed", url, DEFAULT_BROWSER_LIMITS);
    expect(tab.title).toBe("Policy");
    await allowed.wait("allowed", 100);
    expect(forbiddenHits).toBe(0);
    const redirected = await allowed
      .navigate("allowed", tab.id, url + "/redirect", DEFAULT_BROWSER_LIMITS)
      .catch(() => null);
    expect(redirected === null || redirected.status === 403).toBe(true);
    expect(forbiddenHits).toBe(0);
    await expect(
      allowed.navigate(
        "allowed",
        tab.id,
        "file:///etc/passwd",
        DEFAULT_BROWSER_LIMITS,
      ),
    ).rejects.toThrow("Only HTTP and HTTPS");
  } finally {
    await denied.dispose();
    await allowed.dispose();
    fixture.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test("authorized upload and controlled download return bounded bytes without paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-files-"));
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/download")
        return new Response("fixture bytes", {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="fixture.txt"',
          },
        });
      return new Response(
        '<label>Upload<input type="file" aria-label="Upload" onchange="document.querySelector(\'output\').textContent=this.files[0].name"></label><output></output><a href="/download">Download</a>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const engine = new ChromiumBrowserPort({
    profileRoot: root,
    allowedPrivateHosts: ["127.0.0.1"],
  });
  try {
    const tab = await engine.open(
      "files",
      `http://127.0.0.1:${fixture.port}`,
      DEFAULT_BROWSER_LIMITS,
    );
    await engine.action(
      "files",
      "upload",
      {
        locator: { label: "Upload" },
        file: {
          name: "approved.txt",
          mimeType: "text/plain",
          data: Buffer.from("authorized").toString("base64"),
        },
      },
      tab.id,
    );
    expect((await engine.read("files", tab.id)).text).toContain("approved.txt");
    const download = (await engine.action(
      "files",
      "download",
      { locator: { role: "link", name: "Download" } },
      tab.id,
    )) as any;
    expect(download.name).toBe("fixture.txt");
    expect(Buffer.from(download.data, "base64").toString()).toBe(
      "fixture bytes",
    );
    await expect(
      engine.action(
        "files",
        "upload",
        {
          locator: { label: "Upload" },
          file: { name: "../escape", mimeType: "text/plain", data: "eA==" },
        },
        tab.id,
      ),
    ).rejects.toThrow("Invalid authorized upload");
  } finally {
    await engine.dispose();
    fixture.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
