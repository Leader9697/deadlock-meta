import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResponseFallback } from "@deadlock/core";

/**
 * Last-good copy of every deadlock-api answer on disk (DLM_DATA_DIR/api-cache). The
 * in-memory memo is empty after each start of the bundled site, so without this an app
 * opened while deadlock-api or the office proxy is down showed no analysis at all.
 * Saves at most once per 10 min per request; a read-only disk (serverless) just skips.
 */
const dir = () => path.join(process.env.DLM_DATA_DIR || path.join(process.cwd(), ".data"), "api-cache");
const file = (key: string) => path.join(dir(), `${createHash("sha1").update(key).digest("hex")}.json`);
const SAVE_EVERY_MS = 10 * 60_000;
const savedAt = new Map<string, number>();

export const diskFallback: ResponseFallback = {
  async load(key) {
    try {
      const raw = JSON.parse(await fs.readFile(file(key), "utf8")) as { key: string; data: unknown };
      return raw.key === key ? raw.data : undefined;
    } catch {
      return undefined;
    }
  },
  async save(key, data) {
    const now = Date.now();
    if (now - (savedAt.get(key) ?? 0) < SAVE_EVERY_MS) return;
    savedAt.set(key, now);
    try {
      await fs.mkdir(dir(), { recursive: true });
      const f = file(key);
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ key, savedAt: now, data }));
      await fs.rename(tmp, f);
    } catch {
      // read-only or full disk: the copy is a convenience, never an error
    }
  },
};
