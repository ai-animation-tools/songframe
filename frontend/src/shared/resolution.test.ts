import { describe, expect, it } from 'vitest';
import { probeAdvised, resolutionSize } from './resolution';

describe('resolution', () => {
  it('сравнивает разрешения разной записи', () => {
    expect(resolutionSize('1080p')).toBeGreaterThan(resolutionSize('720p'));
    expect(resolutionSize('2k')).toBeGreaterThan(resolutionSize('1080p'));
    expect(resolutionSize('1920x1080')).toBeGreaterThan(resolutionSize('1280×720'));
    expect(resolutionSize('auto')).toBe(0);
  });

  it('советует пробу только выше 720p', () => {
    expect(probeAdvised({ resolution: '1080p', duration: 5 })).toBe(true);
    expect(probeAdvised({ resolution: '720p' })).toBe(false);
    expect(probeAdvised({ resolution: '480p' })).toBe(false);
    expect(probeAdvised({ duration: 5 })).toBe(false);
    expect(probeAdvised(null)).toBe(false);
  });
});
