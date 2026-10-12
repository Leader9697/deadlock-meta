import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Who may read/write the overlay's private data (match logs, habits, calibration).
 *
 * The installed app starts the bundled site with `DLM_INTERNAL_TOKEN` and sends the same
 * value as `x-dlm-token`. Without a token only the dev server (`npm run dev`) is open; a
 * `Host` check is not used because any client can send `Host: localhost`.
 */
export function isAuthorized(headers: Headers): boolean {
  const secret = process.env.DLM_INTERNAL_TOKEN;
  if (!secret) return process.env.NODE_ENV === "development";
  const got = headers.get("x-dlm-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
