import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:19090",
      "/events": "http://127.0.0.1:19090",
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
