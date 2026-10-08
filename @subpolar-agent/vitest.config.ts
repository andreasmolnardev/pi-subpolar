import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost",
      },
    },
    globals: true,
    env: {
      NODE_ENV: "test",
    },
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@subpolar/shared/utils": path.resolve(__dirname, "./src/lib/pi-shared.ts"),
      "@subpolar/shared/config": path.resolve(__dirname, "./src/lib/pi-shared.ts"),
      "@subpolar/shared/schemas": path.resolve(__dirname, "./src/lib/pi-shared.ts"),
      "@subpolar/shared/notifications": path.resolve(__dirname, "./src/lib/pi-shared.ts"),
      "@subpolar/shared": path.resolve(__dirname, "./src/lib/pi-shared.ts"),
    },
  },
});
