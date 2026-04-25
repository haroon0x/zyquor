import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.ZYQUOR_API_URL ?? "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
});
