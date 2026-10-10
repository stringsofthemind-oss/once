# Experimental branch deployment controls

Cloudflare Pages `onceexec` uses its GitHub source integration independently of GitHub Actions. A draft PR or path-limited test workflow does not disable that integration. The previous push created preview `bdabe667-5109-470c-a264-ddff190eec6a`; it was deleted before this preparation run.

On 9 October 2026 the project was inspected using existing host-managed Wrangler authentication, then its source controls were updated and read back:

- `preview_deployment_setting`: `all` -> `custom`
- `preview_branch_includes`: `["*"]` (preserved)
- `preview_branch_excludes`: `[]` -> `["test/*", "experiment/*", "experimental/*"]`
- `production_branch`: `main` (preserved)
- `production_deployments_enabled`: `false` (already false; preserved)
- `deployments_enabled`: `true` (preserved)
- Build command, destination `docs`, path controls and PR comments: preserved.

The production canonical deployment remained `b99dd0f0-065d-4f6c-81df-f02f4f717e4e`. This suppresses automatic Git previews for these prefixes; it does not deploy, alter the existing production workflow, block explicit deployment commands, or cover arbitrary branch names. Experimental work should use one of these prefixes. Inspect the account controls before pushing under a new naming convention. A repository file cannot enforce account-level settings.

Cloudflare documents these controls in its [Pages project update API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/). Excludes require `custom`. Preserve production flags and build configuration when adjusting previews; do not disable the Git integration wholesale or enable production automation as part of a preview fix.
