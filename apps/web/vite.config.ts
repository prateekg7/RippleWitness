import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4400" } },
  preview: { port: Number(process.env.PORT ?? 5173), host: "0.0.0.0", proxy: { "/api": "http://127.0.0.1:4400" } },
});
