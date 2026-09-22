export function renderReport(rows) {
  return [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(row => `${row.id}:${row.value}`)
    .join("\n");
}

export function calculateTotal(values) {
  return values.reduce((sum, value) => sum + value, 0);
}
