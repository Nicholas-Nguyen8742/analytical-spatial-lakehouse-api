import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules"] },

  // Type-aware rules only for files that belong to a tsconfig project. Applying them
  // globally makes ESLint throw on eslint.config.js itself, which no project includes.
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // exhaustive-deps catches stale closures around the map instance and the query
      // filters — the two easiest bugs to introduce in this codebase.
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },

  // Config files are plain JS/ESM and outside every tsconfig project.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    // Single config object, unlike recommendedTypeChecked which is an array.
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // Tests exercise failure paths, so they deliberately handle loosely-typed fixtures.
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
