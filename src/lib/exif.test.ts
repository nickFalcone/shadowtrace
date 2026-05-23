import { describe, it, expect } from 'vitest';
import {
  computeFovDeg,
  getUtcOffsetOptions,
  applyUtcOffset,
  formatDateInput,
  formatTimeInput,
} from './exif';

describe('computeFovDeg', () => {
  it('returns 65° fallback for null', () => {
    expect(computeFovDeg(null)).toBe(65);
  });

  it('returns 65° fallback for zero', () => {
    expect(computeFovDeg(0)).toBe(65);
  });

  it('returns 65° fallback for negative value', () => {
    expect(computeFovDeg(-10)).toBe(65);
  });

  it('computes correct FOV for 50mm lens (~39.6°)', () => {
    // 2 * atan(36 / 100) * (180 / π)
    expect(computeFovDeg(50)).toBeCloseTo(39.6, 1);
  });

  it('computes correct FOV for 24mm wide-angle lens (~73.7°)', () => {
    // 2 * atan(36 / 48) * (180 / π)
    expect(computeFovDeg(24)).toBeCloseTo(73.7, 1);
  });

  it('produces narrower FOV for longer focal lengths', () => {
    expect(computeFovDeg(200)).toBeLessThan(computeFovDeg(50));
    expect(computeFovDeg(50)).toBeLessThan(computeFovDeg(24));
  });
});

describe('getUtcOffsetOptions', () => {
  it('returns 53 entries covering UTC-12:00 to UTC+14:00 in 30-min steps', () => {
    const options = getUtcOffsetOptions();
    expect(options).toHaveLength(53);
  });

  it('starts with UTC-12:00 at -720 minutes', () => {
    const options = getUtcOffsetOptions();
    expect(options[0]).toEqual({ label: 'UTC-12:00', minutes: -720 });
  });

  it('ends with UTC+14:00 at 840 minutes', () => {
    const options = getUtcOffsetOptions();
    expect(options[options.length - 1]).toEqual({ label: 'UTC+14:00', minutes: 840 });
  });

  it('includes UTC+00:00 at 0 minutes', () => {
    const options = getUtcOffsetOptions();
    const utc = options.find(o => o.minutes === 0);
    expect(utc).toEqual({ label: 'UTC+00:00', minutes: 0 });
  });

  it('formats half-hour offsets correctly (UTC+05:30)', () => {
    const options = getUtcOffsetOptions();
    const ist = options.find(o => o.minutes === 330);
    expect(ist).toEqual({ label: 'UTC+05:30', minutes: 330 });
  });
});

describe('applyUtcOffset', () => {
  it('subtracts a positive offset to produce UTC (UTC+5 → 5 hours earlier)', () => {
    const local = new Date('2024-01-01T12:00:00.000Z');
    const utc = applyUtcOffset(local, 300);
    expect(utc.toISOString()).toBe('2024-01-01T07:00:00.000Z');
  });

  it('adds back a negative offset to produce UTC (UTC-5 → 5 hours later)', () => {
    const local = new Date('2024-01-01T12:00:00.000Z');
    const utc = applyUtcOffset(local, -300);
    expect(utc.toISOString()).toBe('2024-01-01T17:00:00.000Z');
  });

  it('returns the same time for a zero offset', () => {
    const local = new Date('2024-06-15T09:30:00.000Z');
    const utc = applyUtcOffset(local, 0);
    expect(utc.toISOString()).toBe('2024-06-15T09:30:00.000Z');
  });
});

describe('formatDateInput', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(formatDateInput(new Date('2024-03-15T14:30:00.000Z'))).toBe('2024-03-15');
  });

  it('handles year boundaries correctly', () => {
    expect(formatDateInput(new Date('2024-01-01T00:00:00.000Z'))).toBe('2024-01-01');
  });
});

describe('formatTimeInput', () => {
  it('formats a UTC time as HH:MM', () => {
    expect(formatTimeInput(new Date('2024-03-15T14:30:00.000Z'))).toBe('14:30');
  });

  it('pads single-digit hours and minutes', () => {
    expect(formatTimeInput(new Date('2024-03-15T09:05:00.000Z'))).toBe('09:05');
  });
});
