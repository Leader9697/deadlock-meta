import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("isAuthorized (private match-log routes)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const h = (o: Record<string, string>) => new Headers(o);

  it("requires the token when one is configured, whatever the Host header says", async () => {
    vi.stubEnv("DLM_INTERNAL_TOKEN", "secret-token");
    vi.stubEnv("NODE_ENV", "production");
    const { isAuthorized } = await import("../lib/auth");
    expect(isAuthorized(h({ host: "localhost:3000" }))).toBe(false);
    expect(isAuthorized(h({ "x-dlm-token": "wrong" }))).toBe(false);
    expect(isAuthorized(h({ "x-dlm-token": "secret-token" }))).toBe(true);
  });

  it("without a token only the dev server is open", async () => {
    vi.stubEnv("DLM_INTERNAL_TOKEN", "");
    const { isAuthorized } = await import("../lib/auth");
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthorized(h({ host: "localhost" }))).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(isAuthorized(h({}))).toBe(true);
  });
});

describe("diskFallback (offline copy of deadlock-api answers)", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "dlm-cache-"));
    vi.stubEnv("DLM_DATA_DIR", dir);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a saved answer and misses unknown keys", async () => {
    const { diskFallback } = await import("../lib/disk-cache");
    await diskFallback.save("/v1/assets/items", [{ id: 1 }]);
    expect(await diskFallback.load("/v1/assets/items")).toEqual([{ id: 1 }]);
    expect(await diskFallback.load("/v1/assets/heroes")).toBeUndefined();
  });

  it("a read-only / missing folder never throws", async () => {
    vi.stubEnv("DLM_DATA_DIR", path.join(dir, "file.txt", "nested"));
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    const { diskFallback } = await import("../lib/disk-cache");
    await expect(diskFallback.save("/k-unwritable", 1)).resolves.toBeUndefined();
    expect(await diskFallback.load("/k-unwritable")).toBeUndefined();
  });
});
