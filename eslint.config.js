// ESLint flat config for zcode-acp-server.
// Focus: catch real bugs and keep imports tidy; prettier handles formatting.
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "*.config.js", "eslint.config.js"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // `no-undef` is a JS rule; TS already catches undefined names via tsc,
      // and it false-positives on global namespaces like `NodeJS`.
      "no-undef": "off",
      // Allow unused function args prefixed with _ (intentional API signatures).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The bridge intentionally narrows loose backend payloads.
      "@typescript-eslint/no-explicit-any": "warn",
      // Permits `as never` to bridge SDK gaps for unstable elicitation schema.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Import ordering/member sorting is left to review + prettier; the
      // rule produces noisy warnings without catching real bugs.
      "sort-imports": "off",
    },
  },
];
