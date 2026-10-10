import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const env = (...keys: string[]) => keys.map((k) => process.env[k]).find((v) => v && v.trim()) || undefined;

const httpsProxy = env("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy");
const httpProxy = env("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy");
if (httpsProxy || httpProxy) {
  const noProxy = env("NO_PROXY", "no_proxy") ?? "localhost,127.0.0.1,::1";
  setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy }));
  console.log(`[deadlock-meta] outgoing requests via proxy ${(httpsProxy ?? httpProxy)!.replace(/\/\/[^@/]*@/, "//***@")}`);
}

// Bundled in the desktop app: exit when the app is gone (crash, task kill), so no
// orphan server keeps the port busy.
const parent = Number(process.env.DLM_PARENT_PID);
if (parent > 0) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 5000).unref();
}
