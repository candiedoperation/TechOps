import path from "path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"

/* The Horizon API and the dashboard are one origin in every deployment: the
   production compose file puts `scripts/serve_local.py` in front of the API,
   and that proxy is what keeps browser requests same-origin. The dev server
   reproduces exactly that allowlist so `location.origin` resolves to a working
   API base here too, with no CORS and no second port in the browser.

   Kept deliberately in step with `is_api_route` in scripts/serve_local.py. */
const API_EXACT_ROUTES = [
  "health",
  "rules",
  "boundaries",
  "audit",
  "feedback",
  "portfolio",
  "progress",
  "snapshots",
]

const API_PREFIXES = [
  "admin",
  "analytics",
  "artifacts",
  "ci",
  "data/horizon",
  "portfolio",
  "progress",
  "projects",
  "recruiting",
  "snapshots",
]

const API_ROUTE_PATTERN =
  `^/(?:${API_EXACT_ROUTES.join("|")})/?(?:\\?.*)?$` +
  `|^/(?:${API_PREFIXES.join("|")})/`

/* PHI_API_BASE is the same override scripts/serve_local.py accepts via
   `--backend`, so a developer pointing one at a remote API points both. */
const API_TARGET = (process.env.PHI_API_BASE || "http://127.0.0.1:8000").replace(/\/$/, "")

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@root": path.resolve(__dirname),
    },
  },

  server: {
    port: 4173,
    proxy: {
      /* The historical artifact path. The API serves these under /artifacts/,
         and the local proxy has always rewritten the legacy prefix rather than
         asking the browser to know about both. */
      "^/data/horizon/": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (routePath: string) => routePath.replace("/data/horizon/", "/artifacts/"),
      },
      [API_ROUTE_PATTERN]: {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
