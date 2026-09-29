export function messageClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function sameMessageDay(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function messageDateLabel(timestamp: number, today: number): string {
  const date = new Date(timestamp);
  const now = new Date(today);
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (that === today) return '今天';
  if (that === today - 86_400_000) return '昨天';
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function conversationGap(previous: string | undefined, role: string): 'none' | 'related' | 'speaker' {
  if (previous === undefined) return 'none';
  return (previous === 'user') === (role === 'user') ? 'related' : 'speaker';
}
