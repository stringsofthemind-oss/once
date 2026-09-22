export function renderSummary(input) {
  const items = [...input.items].sort((a, b) => a.label.localeCompare(b.label));
  return items.map(item => `${item.label}: ${item.value}`).join("\n");
}

export function calculateScore(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}
