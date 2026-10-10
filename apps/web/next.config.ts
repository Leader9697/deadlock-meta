import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NEXT_STANDALONE=1 (scripts/bundle-web.mjs): self-contained server for the desktop app
  ...(process.env.NEXT_STANDALONE ? { output: "standalone" as const, outputFileTracingRoot: path.join(__dirname, "../..") } : {}),
  // core is shipped as TypeScript source and shared with the desktop app
  transpilePackages: ["@deadlock/core"],
  async headers() {
    // Lets the Tauri desktop app (tauri://localhost / http://tauri.localhost) call /api/*.
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: process.env.API_CORS_ORIGIN ?? "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "content-type" },
        ],
      },
    ];
  },
};

export default nextConfig;
