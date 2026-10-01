// Educational simulation only. No SDK execution, provider calls or persistence.
(() => {
	'use strict';
	const host = document.querySelector('[data-retry-demo]');
	if (!host) return;
	const stages = [
		{
			title: 'Ready',
			naive: [],
			safe: [],
			effects: [0, 0],
			state: 'NOT STARTED',
			message: 'Start with one intentional ticket creation. Both paths receive the same request.',
			next: '1. Run first action',
		},
		{
			title: 'Action confirmed',
			naive: ['Ticket #101 created; result received.'],
			safe: ['Ticket #101 created; confirmed result recorded.'],
			effects: [1, 1],
			state: 'CONFIRMED',
			message: 'Both paths created one ticket. The protected path now has a confirmed result for this logical intent.',
			next: '2. Retry same action',
		},
		{
			title: 'Same intent retried',
			naive: ['Ticket #101 created.', 'Blind retry creates ticket #102.'],
			safe: ['Ticket #101 created.', 'Same identity + same input: original #101 returned.'],
			effects: [2, 1],
			state: 'CONFIRMED / REPLAY',
			message: 'Once reuses the confirmed result without a second protected dispatch. The naive control blindly creates another ticket.',
			next: '3. Change the title',
		},
		{
			title: 'Changed input stopped',
			naive: ['Blind retry already created #102.', 'Changed title could become another write.'],
			safe: ['Same identity, different title: CONFLICT.', 'No write dispatched; original receipt is not replayed.'],
			effects: [2, 1],
			state: 'CONFLICT',
			message:
				'An existing identity cannot silently acquire a different effect. A genuinely new intentional action needs a distinct identity.',
			next: '4. Lose an acknowledgement',
		},
		{
			title: 'A separate action has an unknown outcome',
			naive: ['New intent: ticket #201 commits.', 'Response lost; blind retry creates #202.'],
			safe: ['New intent: ticket #201 commits; response lost.', 'Outcome UNKNOWN. Retry blocked; no second dispatch.'],
			effects: [2, 1],
			state: 'UNKNOWN / BLOCKED',
			message:
				'This is a separate lost-ack scenario; counts now refer only to this new intent. The provider committed the ticket, but Once cannot yet establish that. Unknown does not mean failed.',
			next: '5. Reconcile provider truth',
		},
		{
			title: 'Original external result confirmed',
			naive: ['Tickets #201 and #202 exist.'],
			safe: ['Authoritative read-only lookup confirms #201.', 'Original result recorded and returned; no new write.'],
			effects: [2, 1],
			state: 'CONFIRMED / RECONCILED',
			message:
				'This simulated provider has authoritative confirmation. In a real integration, that requires provider-specific reconciliation. The local path does not automatically redispatch after ambiguous absence.',
			next: null,
		},
	];
	let step = 0;
	let unavailable = false;
	const next = host.querySelector('[data-demo-next]');
	const truth = host.querySelector('[data-demo-unavailable]');
	const report = (event) => window.onceTrack?.(event);
	function render() {
		const data = stages[step];
		host.querySelector('[data-demo-title]').textContent = unavailable ? 'Provider truth unavailable' : data.title;
		host.querySelector('[data-demo-state]').textContent = data.state;
		host.querySelector('[data-demo-message]').textContent = unavailable
			? 'Authoritative confirmation is unavailable. Outcome stays UNKNOWN and another dispatch remains blocked. Restore provider truth when ready; never bypass the protection.'
			: data.message;
		for (const [index, side] of ['naive', 'safe'].entries()) {
			host.querySelector(`[data-effects-${side}]`).textContent = String(data.effects[index]);
			const list = host.querySelector(`[data-events-${side}]`);
			list.replaceChildren(
				...data[side].map((text) => {
					const li = document.createElement('li');
					li.textContent = text;
					return li;
				}),
			);
		}
		next.hidden = !data.next;
		if (data.next) next.textContent = unavailable ? 'Restore truth and reconcile' : data.next;
		truth.hidden = step !== 4 || unavailable;
		host.querySelector('[data-demo-result]').hidden = step !== 5;
	}
	next.addEventListener('click', () => {
		step = Math.min(step + 1, stages.length - 1);
		unavailable = false;
		if (step === 1) report('demo_started');
		if (step === 4) report('unknown_state_viewed');
		if (step === 5) report('demo_completed');
		render();
		if (next.hidden) host.querySelector('[data-demo-reset]').focus();
	});
	truth.addEventListener('click', () => {
		unavailable = true;
		render();
		next.focus();
	});
	host.querySelector('[data-demo-reset]').addEventListener('click', () => {
		step = 0;
		unavailable = false;
		render();
		next.focus();
	});
	host.querySelector('[data-demo-controls]').hidden = false;
	render();
})();
