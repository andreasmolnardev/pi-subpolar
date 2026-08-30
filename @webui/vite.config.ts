import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [
      react(),
      tailwindcss(),
    ],
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
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:4173",
          changeOrigin: true,
        },
      },
    },
    build: {
      assetsInlineLimit: 4096,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
        },
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          assetFileNames: (assetInfo) => {
            if (assetInfo.name === "manifest.json") {
              return "manifest.json";
            }
            return "assets/[name]-[hash][extname]";
          },
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 5173,
    },
    worker: {
      rollupOptions: {
        output: {
          entryFileNames: "sw.js",
        },
      },
    }
});
