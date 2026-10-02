(() => {
	'use strict';
	const status = document.querySelector('[data-copy-status]');
	document.querySelectorAll('[data-copy-target]').forEach((button) => {
		button.addEventListener('click', async () => {
			const source = document.getElementById(button.dataset.copyTarget);
			if (!source) return;
			try {
				await navigator.clipboard.writeText(source.textContent);
				button.textContent = 'Copied';
				if (status) status.textContent = 'Copied to clipboard.';
				window.onceTrack?.(button.dataset.copyEvent || 'install_copied');
				setTimeout(() => {
					button.textContent = button.dataset.copyLabel || 'Copy';
				}, 1600);
			} catch {
				button.textContent = 'Select and copy below';
				if (status) status.textContent = 'Clipboard unavailable. Select the text below and copy it manually.';
				source.tabIndex = 0;
				source.focus();
				const selection = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(source);
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
		});
	});
	const form = document.querySelector('[data-exposure-form]');
	if (form) {
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!form.reportValidity()) return;
			const calls = Number(form.elements.calls.value);
			const rate = Number(form.elements.rate.value) / 100;
			const value = Number(form.elements.value.value);
			const retries = calls * rate;
			document.querySelector('[data-exposure-result]').textContent =
				`${retries.toLocaleString()} estimated retry events per month; £${(retries * value).toLocaleString(undefined, { maximumFractionDigits: 2 })} of action value passes through these events. This is exposure context, not duplicate count, savings, or measured throughput.`;
		});
	}
})();
