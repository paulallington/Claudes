function deriveHeadlessTitle(prompt) {
  if (typeof prompt !== 'string') return '(empty)';
  const lines = prompt.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 80);
  }
  return '(empty)';
}

module.exports = { deriveHeadlessTitle };
