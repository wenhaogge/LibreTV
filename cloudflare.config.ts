import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  accountId: "697bb6297b607ef039255d9d5c5b51f7",
  worker: defineWorker({
    name: "libretv-v2",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-09-30",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    assets: { notFoundHandling: "none" },
    env: {
      ASSETS: bindings.assets(),
      PASSWORD: bindings.secret(),
      PROXY_SECRET: bindings.secret(),
      DEFAULT_SOURCES: bindings.secret(),
    },
  }),
});
