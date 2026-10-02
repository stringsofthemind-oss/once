(() => {
	'use strict';
	// Website interaction counts only. No cookies, persistent IDs, payloads,
	// source code, URLs, form values or SDK activation telemetry.
	const allowed = new Set([
		'homepage_view',
		'hero_demo_click',
		'demo_started',
		'demo_completed',
		'unknown_state_viewed',
		'protect_first_action_click',
		'mode_selected',
		'quickstart_started',
		'install_copied',
		'first_action_step_reached',
		'github_click',
		'docs_click',
		'hosted_sandbox_click',
	]);
	const sent = new Set();
	window.onceTrack = (event) => {
		if (!allowed.has(event) || sent.has(event)) return;
		if (
			navigator.doNotTrack === '1' ||
			navigator.globalPrivacyControl ||
			!['onceexec.com', 'onceexec.pages.dev', 'stringsofthemind-oss.github.io'].includes(location.hostname)
		)
			return;
		sent.add(event);
		fetch('https://playground.onceexec.com/analytics/event', {
			method: 'POST',
			credentials: 'omit',
			referrerPolicy: 'no-referrer',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ event, source: 'website' }),
			keepalive: true,
		}).catch(() => {});
	};
	document.querySelectorAll('[data-event]').forEach((element) => {
		element.addEventListener('click', () => window.onceTrack(element.dataset.event));
	});
	if (location.pathname === '/') window.onceTrack('homepage_view');
	if (location.pathname.startsWith('/quickstart')) window.onceTrack('quickstart_started');
})();
