# Once Worker Deployment Safety

Production Worker deployment is deliberately guarded.

## Protected Workers

- Runtime: `once-q18-cloud`
- Playground: `once-sandbox-playground`

## Commands

`npm run deploy` intentionally refuses to deploy.

Safe dry-run:

```bash
npm ci
npm run deploy:dry-run
```

Runtime production deployment:

```bash
npm run deploy:production -- --confirm=once-q18-cloud
```

Playground production deployment:

```bash
npm run deploy:production -- --confirm=once-sandbox-playground
```

## Production gates

The production wrapper verifies the expected repository and Worker identity, requires main, requires a clean worktree, fetches origin, requires HEAD to equal origin/main, refuses CI, requires an interactive terminal, requires the exact Worker confirmation, uses locally installed Wrangler, runs a dry-run first, rechecks Git state, and then requires a second exact interactive confirmation.

The final confirmation is:

```text
DEPLOY <worker-name>
```

Only after all gates pass can the wrapper invoke real `wrangler deploy`.

## Boundary

This protects the normal npm deployment path. An authorized Cloudflare operator could still deliberately bypass it and invoke Wrangler directly. Cloudflare permissions remain the ultimate deployment authority.

## Durable Objects

Do not change Durable Object lifecycle, namespace, storage, or migration configuration merely to silence Wrangler warnings.

## Recovered source

This guard does not modify the recovered Worker runtime source or authorize a production deployment.