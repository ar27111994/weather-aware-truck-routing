import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

// In development the SPA calls the API on its own origin (`/api/v1/...`), exactly like production
// where Vercel serves both. The proxy forwards to the local Django dev server.
const DJANGO_DEV_SERVER = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [reactRouter()],
  server: {
    proxy: { "/api": DJANGO_DEV_SERVER },
  },
});
