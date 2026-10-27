export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Старое положение используем только если окно осталось доступно хотя бы на одном мониторе. */
export function usableMontageBounds(saved: unknown, displays: WindowBounds[]): WindowBounds | undefined {
  if (!saved || typeof saved !== 'object' || !displays.length) return undefined;
  const bounds = saved as WindowBounds;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 480 || bounds.height < 270) return undefined;
  const visible = displays.some((area) => {
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return width >= 100 && height >= 100 && bounds.y >= area.y && bounds.y < area.y + area.height - 30;
  });
  return visible ? bounds : undefined;
}
