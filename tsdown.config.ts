import { defineConfig } from "tsdown";

const shared = {
  format: "esm",
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
  sourcemap: false,
  // emit .js (not .mjs); package.json already has "type": "module"
  fixedExtension: false,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    outDir: "dist",
    // Keep everything in one file so `npx <pkg>` starts a single script.
    outputOptions: { codeSplitting: false },
  },
  {
    // Test-only build of the client installer. Must sit one level below the package root,
    // because config.ts resolves ../package.json at runtime.
    ...shared,
    entry: ["src/install.ts"],
    outDir: ".build",
  },
]);
