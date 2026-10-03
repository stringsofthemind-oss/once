// Automated acceptance checks against a disposable local HTTP server.
// npm install --no-save playwright, then npx playwright install chromium.
// Optional environment paths let an existing browser/runtime be reused.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const docs = resolve(root, 'docs');
const published = JSON.parse(readFileSync(resolve(docs, 'published-versions.json'), 'utf8'));
const artifacts = process.env.ONCE_WEBSITE_ARTIFACTS || resolve(root, '.website-check');
mkdirSync(artifacts, { recursive: true });
const { chromium } = await import(process.env.ONCE_PLAYWRIGHT_MODULE || 'playwright');
const server = createServer((req, res) => {
	let file = resolve(docs, '.' + new URL(req.url, 'http://localhost').pathname);
	if (!file.startsWith(docs + sep) && file !== docs) {
		res.writeHead(403).end();
		return;
	}
	if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, 'index.html');
	if (!existsSync(file)) {
		res.writeHead(404).end();
		return;
	}
	const types = {
		'.html': 'text/html',
		'.js': 'text/javascript',
		'.css': 'text/css',
		'.mjs': 'text/javascript',
		'.json': 'application/json',
	};
	res.setHeader('content-type', types[extname(file)] || 'text/plain');
	res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
	headless: true,
	...(process.env.ONCE_CHROMIUM_PATH
		? { executablePath: process.env.ONCE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
		: {}),
});
const errors = [];
try {
	const page = await browser.newPage();
	page.on('pageerror', (e) => errors.push(e.message));
	for (const width of [360, 390, 768, 1440]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto(base);
		assert.equal(await page.locator('h1').count(), 1);
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
		const hero = page.locator('.hero').getByRole('link', { name: 'Run the retry demo' });
		const bounds = await hero.boundingBox();
		assert.ok(bounds.y + bounds.height < 1000, `primary CTA too late at ${width}`);
		await page.screenshot({ path: resolve(artifacts, `home-${width}.png`) });
		await hero.click();
		const next = page.locator('[data-demo-next]');
		await next.click();
		await next.click();
		assert.equal(await page.locator('[data-effects-safe]').innerText(), '1');
		assert.equal(await page.locator('[data-effects-naive]').innerText(), '2');
		await next.click();
		assert.match(await page.locator('[data-demo-state]').innerText(), /CONFLICT/);
		await next.click();
		assert.match(await page.locator('[data-demo-state]').innerText(), /UNKNOWN/);
		await page.getByRole('button', { name: 'Provider truth unavailable', exact: true }).click();
		assert.match(await page.locator('[data-demo-message]').innerText(), /stays UNKNOWN/);
		assert.equal(await page.locator('[data-effects-safe]').innerText(), '1');
		await next.click();
		assert.match(await page.locator('[data-demo-state]').innerText(), /RECONCILED/);
		assert.ok(await page.locator('[data-demo-result]').isVisible());
		await page.screenshot({ path: resolve(artifacts, `demo-${width}.png`) });
		for (const route of ['/quickstart/', '/evidence/', '/demo/', '/retry-exposure/']) {
			await page.goto(base + route);
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflow at ${width}`);
		}
	}
	await page.goto(base + '/quickstart/');
	// Stub clipboard only in this test to verify the handler's actual text/feedback.
	await page.evaluate(() => {
		window.testCopied = '';
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: async (t) => {
					window.testCopied = t;
				},
			},
			configurable: true,
		});
	});
	await page.getByRole('button', { name: 'Copy setup commands', exact: true }).click();
	assert.ok((await page.evaluate(() => window.testCopied)).includes(`npm install @once-agent/sdk@${published.ts}`));
	assert.equal(await page.locator('[data-copy-status]').innerText(), 'Copied to clipboard.');
	await page.locator('summary').first().click();
	const sample = await page.locator('#example').innerText();
	assert.equal(sample, readFileSync(resolve(docs, 'quickstart/first-action.mjs'), 'utf8').replaceAll('\r\n', '\n'));
	await page.screenshot({ path: resolve(artifacts, 'quickstart.png') });
	await page.goto(base + '/retry-exposure/');
	await page.getByRole('button', { name: 'Estimate exposure' }).click();
	assert.match(await page.locator('[data-exposure-result]').innerText(), /10 estimated retry events/);
	await page.goto(base);
	await page.keyboard.press('Tab');
	assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Skip to content');
	await page.keyboard.press('Enter');
	assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
	await page.setViewportSize({ width: 720, height: 500 }); // 1440 viewport at 200% effective CSS width
	await page.goto(base);
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% reflow');
	await page.screenshot({ path: resolve(artifacts, 'zoom-reflow.png') });
	const noJs = await browser.newPage({ javaScriptEnabled: false });
	await noJs.goto(base + '/demo/');
	assert.ok(await noJs.locator('noscript p').isVisible());
	assert.equal(await noJs.locator('[data-demo-controls]').isVisible(), false);
	assert.deepEqual(errors, []);
	console.log(
		'PASS browser acceptance: 360/390/768/1440, all funnel pages, replay/conflict/UNKNOWN/unavailable truth/reconciliation, clipboard, code parity, calculator, keyboard skip, reduced motion, 200% reflow, no-JS and no console exceptions',
	);
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
