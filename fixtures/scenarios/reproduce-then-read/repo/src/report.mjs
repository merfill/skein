export function summarize(rows) {
  return rows.map((row) => `${row.name}: ${formatScore(row.score)}`);
}

function fmt(score) {
  return score.toFixed(2);
}
