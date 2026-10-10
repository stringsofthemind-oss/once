# Website browser acceptance

From the repository root:

```sh
npm ci --prefix scripts/website-qa
node scripts/website-qa/node_modules/playwright/cli.js install --with-deps chromium
node scripts/check-site-surface.mjs
node scripts/generate-site-surface.mjs --check
node scripts/website-browser-check.mjs
```

The dependency and lockfile pin the browser runner independently of shipped SDK and MCP packages. CI runs the same suite on Linux and Windows and retains screenshots for 14 days. Local screenshots go to `.website-check/`; set `ONCE_WEBSITE_ARTIFACTS` to use another directory.

The suite serves repository documentation on loopback. It checks four viewport widths, funnel navigation, simulated replay/conflict/UNKNOWN/reconciliation, clipboard text, published-version/code parity, keyboard skip navigation, reduced motion, reflow and no-JavaScript behavior. These are website acceptance checks, not external-provider safety or adoption evidence. It does not verify a production deployment or constitute a complete accessibility audit.
