// Local ESLint override for the Playwright E2E suite.
//
// The parent `.eslintrc.cjs` ties parsing to `frontend/tsconfig.json`, which
// only includes `src/**/*.ts`. The e2e tests live outside `src/` and need
// their own tsconfig project so typescript-eslint can apply type-aware
// rules to them. We also relax a couple of test-only ergonomics.

module.exports = {
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
  },
  env: {
    browser: true,
    node: true,
  },
  rules: {
    // The Playwright config exports a default config object; CommonJS/ESM
    // interop diagnostics from typed linting are not useful here.
    "@typescript-eslint/no-misused-promises": "off",
  },
};
