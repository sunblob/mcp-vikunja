import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,
  // Keep everything in one file so `npx <pkg>` starts a single script.
  outputOptions: { codeSplitting: false },
  // emit dist/index.js (not .mjs); package.json already has "type": "module"
  fixedExtension: false,
});
