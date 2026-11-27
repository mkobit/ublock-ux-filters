import { describe, expect, it } from "bun:test";
import type { BuildManifest } from "./render.ts";
import worker, { handleCustomListRequest, type WorkerEnv } from "./worker.ts";

function createManifest(): BuildManifest {
  return {
    version: "abc1234",
    generatedAt: "2026-11-27T00:00:00.000Z",
    expires: "1 day",
    hosts: {
      "example.com": {
        displayName: "Example",
        defaultVariant: "minimal",
        variants: ["minimal"],
      },
      "other.com": {
        displayName: "Other",
        defaultVariant: "clean",
        variants: ["clean"],
      },
    },
    sets: {},
    aliases: {},
    entries: {
      "example.com/minimal": {
        id: "example.com/minimal",
        host: "example.com",
        variant: "minimal",
        description: "Minimal example",
        tags: [],
        resolvedIncludes: [],
        fragmentPath: "fragments/example.com/minimal.txt",
        ruleCount: 1,
        sha256: "111",
      },
      "other.com/clean": {
        id: "other.com/clean",
        host: "other.com",
        variant: "clean",
        description: "Clean other",
        tags: [],
        resolvedIncludes: [],
        fragmentPath: "fragments/other.com/clean.txt",
        ruleCount: 1,
        sha256: "222",
      },
    },
  };
}

function createEnv(assets: Record<string, { body: string; status?: number; contentType?: string }>): {
  env: WorkerEnv;
  requests: string[];
} {
  const requests: string[] = [];
  const env: WorkerEnv = {
    ASSETS: {
      async fetch(input: Request | string): Promise<Response> {
        const url = typeof input === "string" ? input : input.url;
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        const asset = assets[pathname];
        if (!asset) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(asset.body, {
          status: asset.status ?? 200,
          headers: {
            "Content-Type": asset.contentType ?? "text/plain; charset=utf-8",
          },
        });
      },
    },
  };
  return { env, requests };
}

describe("worker", () => {
  it("delegates non-custom requests to ASSETS", async () => {
    const { env, requests } = createEnv({
      "/index.html": { body: "<h1>Catalog</h1>", contentType: "text/html" },
    });

    const response = await worker.fetch(new Request("https://filters.example/index.html"), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>Catalog</h1>");
    expect(requests).toEqual(["/index.html"]);
  });

  it("composes a uBlock Origin filter list for GET /custom.txt", async () => {
    const manifest = createManifest();
    const { env } = createEnv({
      "/manifest.json": { body: JSON.stringify(manifest), contentType: "application/json" },
      "/fragments/example.com/minimal.txt": {
        body: "[Adblock Plus 2.0]\n! Title: example.com/minimal\n! Expires: 1 day\nexample.com##.banner\n",
      },
      "/fragments/other.com/clean.txt": {
        body: "! Title: other.com/clean\nother.com##.sidebar\n",
      },
    });

    const response = await handleCustomListRequest(
      new Request("https://filters.example/custom.txt?include=other.com/clean,%20example.com/minimal,other.com/clean"),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.text()).toBe(
      [
        "! Title: ublock-ux-filters (custom)",
        "! Expires: 1 day",
        "! Includes: example.com/minimal, other.com/clean",
        "",
        "! --- example.com/minimal ---",
        "example.com##.banner",
        "",
        "! --- other.com/clean ---",
        "other.com##.sidebar",
        "",
      ].join("\n"),
    );
  });

  it("returns headers with an empty body for HEAD /custom.txt", async () => {
    const manifest = createManifest();
    const { env } = createEnv({
      "/manifest.json": { body: JSON.stringify(manifest), contentType: "application/json" },
      "/fragments/example.com/minimal.txt": {
        body: "example.com##.banner\n",
      },
    });

    const response = await handleCustomListRequest(
      new Request("https://filters.example/custom.txt?include=example.com/minimal", { method: "HEAD" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.text()).toBe("");
  });

  it("returns 400 when include is missing or empty", async () => {
    const { env, requests } = createEnv({});

    const missingResponse = await handleCustomListRequest(
      new Request("https://filters.example/custom.txt"),
      env,
    );
    const emptyResponse = await handleCustomListRequest(
      new Request("https://filters.example/custom.txt?include=%20,%20"),
      env,
    );

    expect(missingResponse.status).toBe(400);
    expect(missingResponse.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(emptyResponse.status).toBe(400);
    expect(emptyResponse.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(requests).toEqual([]);
  });

  it("returns 400 listing unknown entry IDs", async () => {
    const manifest = createManifest();
    const { env } = createEnv({
      "/manifest.json": { body: JSON.stringify(manifest), contentType: "application/json" },
    });

    const response = await handleCustomListRequest(
      new Request("https://filters.example/custom.txt?include=example.com/minimal,bad.example/one,toString"),
      env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("bad.example/one");
    expect(body).toContain("toString");
  });

  it("returns 500 when manifest.json is missing from ASSETS", async () => {
    const { env } = createEnv({});

    const response = await handleCustomListRequest(
      new Request("https://filters.example/custom.txt?include=example.com/minimal"),
      env,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });
});
