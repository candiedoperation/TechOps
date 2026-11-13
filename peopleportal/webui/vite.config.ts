import path from "path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'PP_DEV_')

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@root": path.resolve(__dirname),
      },
    },

    server: {
      ...(env.PP_DEV_WEBUI_PORT ? { port: Number(env.PP_DEV_WEBUI_PORT), strictPort: true } : {}),
      proxy: {
        '/api': {
          target: `http://localhost:${env.PP_DEV_PORTAL_PORT || 3000}`,
        }
      }
    }
  }
})
