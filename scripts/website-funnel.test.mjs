import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import playground from '../workers/playground/src/index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const docs = resolve(root, 'docs');
const pages = ['index.html', 'first10/index.html', 'demo/index.html', 'quickstart/index.html', 'evidence/index.html', 'retry-exposure/index.html'];

test('new funnel local links and fragment destinations resolve', () => {
	for (const file of pages) {
		const source = readFileSync(resolve(docs, file), 'utf8');
		assert.equal((source.match(/<h1[ >]/g) || []).length, 1, `${file}: one main heading`);
		assert.match(source, /<main\b[^>]*\bid="main"/);
		for (const [, target] of source.matchAll(/href="([^"]+)"/g)) {
			if (/^(https?:|mailto:)/.test(target)) continue;
			const [path, fragment] = target.split('#');
			let absolute = path.startsWith('/')
				? resolve(docs, '.' + path)
				: resolve(dirname(resolve(docs, file)), path || file.split('/').at(-1));
			if (path.endsWith('/')) absolute = resolve(absolute, 'index.html');
			assert.ok(existsSync(absolute), `${file}: missing ${target}`);
			if (fragment) assert.ok(readFileSync(absolute, 'utf8').includes(`id="${fragment}"`), `${file}: missing fragment ${target}`);
		}
	}
});
test('playground root is ungated and does not need a billing environment', async () => {
	const response = await playground.fetch(new Request('https://playground.onceexec.com/'), {});
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /INTERACTIVE SIMULATION/);
	assert.doesNotMatch(body, /Start Pro Sandbox|\/api\/checkout|STRIPE|cs_test/);
	assert.match(body, /Outcome stays UNKNOWN/);
});
test('hosted activation remains a separate explicitly named route', async () => {
	const response = await playground.fetch(new Request('https://playground.onceexec.com/hosted'), {});
	const body = await response.text();
	assert.match(body, /Start Pro Sandbox/);
	assert.match(body, /Optional hosted activation uses Stripe test checkout/);
	assert.match(body, /Run the ungated simulation first/);
});
test('website funnel events use bounded allowlist and no SDK activation claim', async () => {
	const writes = [];
	const env = { ONCE_ANALYTICS: { writeDataPoint: (value) => writes.push(value) } };
	const request = (event) =>
		new Request('https://playground.onceexec.com/analytics/event', {
			method: 'POST',
			headers: { origin: 'https://onceexec.com', 'content-type': 'application/json' },
			body: JSON.stringify({ event, source: 'website' }),
		});
	assert.equal((await playground.fetch(request('demo_completed'), env)).status, 204);
	assert.deepEqual(writes[0].blobs, ['demo_completed', 'website']);
	assert.equal((await playground.fetch(request('sdk_activated'), env)).status, 400);
	assert.equal(writes.length, 1);
});
