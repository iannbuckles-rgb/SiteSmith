export function formatRelativeSavedAt(savedAt: number): string {
  if (!Number.isFinite(savedAt)) return 'saved sometime';
  const deltaMs = Math.max(0, Date.now() - savedAt);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (deltaMs < minuteMs) return 'just now';
  if (deltaMs < hourMs) {
    const minutes = Math.floor(deltaMs / minuteMs);
    return `${minutes}m ago`;
  }
  if (deltaMs < dayMs) {
    const hours = Math.floor(deltaMs / hourMs);
    return `${hours}h ago`;
  }
  const days = Math.floor(deltaMs / dayMs);
  return `${days}d ago`;
}
