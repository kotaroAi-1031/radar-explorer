import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Worker (name, entrypoint, bindings, cron trigger) is defined in
// cloudflare.config.ts; this file only wires the Cloudflare plugin and
// React into Vite so `cf build` / `cf deploy` can bundle the Worker and
// the SPA client together.
export default defineConfig({
  plugins: [cloudflare(), react()],
});
