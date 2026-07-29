import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.VITE_API_PORT || 3210}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@tanstack")) return "query";
            if (id.includes("react-dom") || id.includes("/react/")) return "react";
            if (id.includes("@dnd-kit")) return "dnd";
            if (id.includes("lucide-react")) return "icons";
          }
          if (id.includes("/features/materials/")) return "materials";
          if (id.includes("/features/design/")) return "design";
          if (id.includes("/features/history/")) return "history";
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
  },
});
