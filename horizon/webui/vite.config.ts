import { defineConfig, loadEnv } from 'vite'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command, mode, isPreview }) => {
  const allowed = command === 'serve' && !isPreview && mode === 'development'
  const requested =
    (process.env.VITE_HORIZON_DEMO ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_HORIZON_DEMO) ===
    'true'
  return {
    define: { __HORIZON_DEMO_BUILD_ALLOWED__: JSON.stringify(allowed) },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'horizon-local-demo-worker',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.split('?')[0] !== '/__horizon_demo__/mockServiceWorker.js')
              return next()
            if (!allowed || !requested) {
              response.statusCode = 404
              response.end()
              return
            }
            response.setHeader('Content-Type', 'application/javascript')
            response.setHeader('Cache-Control', 'no-store')
            response.setHeader('Service-Worker-Allowed', '/')
            response.end(
              readFileSync(createRequire(import.meta.url).resolve('msw/mockServiceWorker.js')),
            )
          })
        },
      },
    ],
    server: { host: '127.0.0.1', port: 5174, strictPort: true },
    preview: { host: '127.0.0.1', port: 4174, strictPort: true },
  }
})
