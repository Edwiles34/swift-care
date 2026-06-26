import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  server: { port: 3001 },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      input: {
        main:          resolve(__dirname, "index.html"),
        admin:         resolve(__dirname, "admin.html"),
        hospitalAdmin: resolve(__dirname, "hospital-admin.html"),
        kiosk:         resolve(__dirname, "kiosk.html"),
      },
    },
  },
});
