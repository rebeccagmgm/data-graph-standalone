import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      strictPort: true,
      port: Number(env.DATA_GRAPH_UI_PORT || 8792),
      proxy: {
        "/api": {
          target: env.DATA_GRAPH_API_ORIGIN || "http://127.0.0.1:8791",
          changeOrigin: false,
        },
      },
    },
  };
});
