/**
 * Runs once at server start. Routes the server's outgoing fetch (deadlock-api calls)
 * through an HTTP proxy when one is configured, e.g. an office proxy:
 *
 *   apps/web/.env.local
 *     HTTPS_PROXY=http://proxy.example.co.id:8080
 *
 * HTTP_PROXY / HTTPS_PROXY / NO_PROXY (and lowercase variants) are honoured.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("./instrumentation-node");
}
