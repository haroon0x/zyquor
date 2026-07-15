import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

function cspPlugin(): Plugin {
  return {
    name: "zyquor-csp",
    apply: "build",
    transformIndexHtml(html) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src http://127.0.0.1:* http://localhost:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'">`;
      return html.replace("</head>", `  ${meta}\n  </head>`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), cspPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.ZYQUOR_API_URL ?? "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
