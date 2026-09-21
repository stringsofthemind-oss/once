# Once Runtime Worker

This directory contains the recovered source for the production Once runtime Worker.

## Production identity

Worker:

`once-q18-cloud`

Customer-facing runtime:

`https://api.onceexec.com`

A legacy workers.dev runtime URL remains in service for compatibility with published Once SDK versions that may still reference it.

## Recovered production baseline

The Worker source in this directory was recovered from the deployed Cloudflare Worker and preserved byte-for-byte in Git.

Recovered baseline commit:

`34eea5baa1e64eb1d993a80c1ec74bd6656b4898`

Preserved production files:

- `src/index.js`
- `src/index.js.map`
- `wrangler.jsonc`
- `package.json`
- `package-lock.json`

The source map is intentionally preserved because the deployed `src/index.js` references it and it contains embedded source material from the recovered Worker.

## Durable Object

Binding:

- `Q18_TRUTH` -> `Q18Truth`

The recovered Wrangler configuration identifies `Q18Truth` as a Durable Object exported by this Worker.

Wrangler 4.135.0 currently warns that the recovered configuration does not contain the newer live `exports` lifecycle declaration for this Durable Object.

Do not add or alter Durable Object lifecycle configuration merely to silence this warning.

Any Durable Object lifecycle or storage migration must be handled as a separate infrastructure change and verified against the production namespace before deployment.

## Recovery verification

The recovered baseline was verified before preservation:

- recovered files matched their destination copies byte-for-byte
- all five Git index blobs matched the recovered source blobs exactly
- all five committed Git blobs matched the recovered source blobs exactly
- credential-shaped secret scanning returned zero strict credential matches
- `npm ci` completed successfully
- `node --check src/index.js` completed successfully
- `wrangler deploy --dry-run` completed successfully
- Wrangler recognized the `Q18_TRUTH` Durable Object binding

The dry-run did not deploy or modify the production Worker.

## Secrets

Production secret values are managed outside this repository.

Do not place production secret values in source control.

## Deployment safety

Recovery of this directory does not authorize deployment from it.

Before any future runtime deployment:

1. Confirm the currently active production Worker version.
2. Verify the production Durable Object namespace and lifecycle configuration.
3. Review all changes relative to this recovered baseline.
4. Run local syntax and Wrangler dry-run checks.
5. Inspect the candidate Worker version before directing production traffic to it.
6. Smoke-test the branded runtime and any legacy compatibility endpoint after promotion.

Changes to Durable Object lifecycle configuration must be treated separately from ordinary application-code changes.