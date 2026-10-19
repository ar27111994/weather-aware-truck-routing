import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

// In development the SPA calls the API on its own origin (`/api/v1/...`), exactly like production
// where Vercel serves both. The proxy forwards to the local Django dev server.
const DJANGO_DEV_SERVER = "http://127.0.0.1:8000";

// Parallel workers share one machine (PROJECT.md section 9), so the dev server owns one port and
// refuses to hop to another when it is taken. T6a owns 5201; `DEV_PORT` overrides it.
const DEV_PORT = Number(process.env["DEV_PORT"] ?? 5201);

export default defineConfig({
  plugins: [reactRouter()],
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: { "/api": DJANGO_DEV_SERVER },
  },
});
