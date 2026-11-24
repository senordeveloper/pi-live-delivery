/** Recognize explicit task limits, not durations of videos, simulations or delivery intervals. */
export function requestedBudget(text: string): number | undefined {
  const duration =
    '(\\d+(?:\\.\\d+)?)\\s*(秒|分钟|分|小时|天|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])';
  const patterns = [
    new RegExp(
      '(?:总执行时间|总时间|总时长|执行上限|时间预算|总预算|total (?:time|budget)|time budget)\\s*(?:为|是|[:：=]|不超过|最多|限制为)?\\s*' +
        duration,
      'ig',
    ),
    new RegExp(
      '(?:请)?(?:在|用|限时)\\s*' + duration + '\\s*(?:内)?(?:完成|做|制作|实现|交付)',
      'ig',
    ),
    new RegExp(
      '(?:finish|complete|deliver)\\b[^.。\\n]{0,40}?\\b(?:in|within)\\s*' + duration + '\\b',
      'ig',
    ),
  ];
  const units: Record<string, number> = {
    秒: 1,
    分钟: 60,
    分: 60,
    小时: 3600,
    天: 86400,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  const found = patterns
    .flatMap((pattern) => [...text.matchAll(pattern)])
    .sort((a, b) => a.index! - b.index!);
  const match = found.at(-1);
  if (!match) return undefined;
  const unit = match[2].toLowerCase();
  const multiplier =
    units[unit] ?? (/^s/.test(unit) ? 1 : /^m/.test(unit) ? 60 : /^h/.test(unit) ? 3600 : 86400);
  const seconds = Math.round(Number(match[1]) * multiplier);
  return seconds >= 30 && seconds <= 604800 ? seconds : undefined;
}
