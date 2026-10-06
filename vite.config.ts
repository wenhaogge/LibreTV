import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

// Keep local dev discovery inside this project, separate from global Wrangler state.
process.env.MINIFLARE_REGISTRY_PATH = path.join(import.meta.dirname, ".cloudflare", "registry");

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      remoteBindings: false,
      tunnel: false,
      inspectorPort: false,
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
