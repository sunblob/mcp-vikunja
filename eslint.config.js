import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".build/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // stdout is the MCP protocol channel; only console.error is allowed in server code
      "no-console": ["error", { allow: ["error"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // setup.ts and the CLI help path are interactive and legitimately print to stdout
    files: ["src/setup.ts", "src/index.ts"],
    rules: { "no-console": "off" },
  },
);
