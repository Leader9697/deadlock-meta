import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // the real package throws outside a React Server Component build
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
