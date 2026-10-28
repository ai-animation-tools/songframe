/** Русское согласование числа и существительного: 1 кадр, 2 кадра, 5 кадров; дробное — как «2,5 кадра». */
export function plural(count: number, one: string, few: string, many: string): string {
  if (!Number.isInteger(count)) return few;
  const n = Math.abs(count) % 100;
  const last = n % 10;
  if (n >= 11 && n <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Число с согласованным словом: «24 кредита». */
export function countLabel(count: number, one: string, few: string, many: string): string {
  return `${count} ${plural(count, one, few, many)}`;
}
