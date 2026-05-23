import { describe, it, expect } from 'vitest';
import {
  computeFovDeg,
  getUtcOffsetOptions,
  applyUtcOffset,
  formatDateInput,
  formatTimeInput,
  parseUtcOffset,
  correctMagneticBearing,
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

  it('computes correct FOV for 50mm lens (~39.6°) in landscape', () => {
    // 2 * atan(36 / 100) * (180 / π)
    expect(computeFovDeg(50)).toBeCloseTo(39.6, 1);
  });

  it('computes correct FOV for 24mm wide-angle lens (~73.7°) in landscape', () => {
    // 2 * atan(36 / 48) * (180 / π)
    expect(computeFovDeg(24)).toBeCloseTo(73.7, 1);
  });

  it('produces narrower FOV for longer focal lengths', () => {
    expect(computeFovDeg(200)).toBeLessThan(computeFovDeg(50));
    expect(computeFovDeg(50)).toBeLessThan(computeFovDeg(24));
  });

  it('uses the 24mm short sensor dimension in portrait orientation', () => {
    // Portrait FOV at 50mm: 2 * atan(24 / 100) * (180 / π) ≈ 27.0°
    expect(computeFovDeg(50, true)).toBeCloseTo(27.0, 1);
  });

  it('produces narrower FOV in portrait than landscape for the same lens', () => {
    expect(computeFovDeg(50, true)).toBeLessThan(computeFovDeg(50, false));
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

// ─── parseUtcOffset ──────────────────────────────────────────────────────────

describe('parseUtcOffset', () => {
  it('parses "+HH:MM"', () => {
    expect(parseUtcOffset('+05:30')).toBe(330);
    expect(parseUtcOffset('-08:00')).toBe(-480);
  });

  it('parses "+HHMM" (no colon)', () => {
    expect(parseUtcOffset('+0530')).toBe(330);
    expect(parseUtcOffset('-0800')).toBe(-480);
  });

  it('parses "+HH" (no minutes)', () => {
    expect(parseUtcOffset('+05')).toBe(300);
    expect(parseUtcOffset('-08')).toBe(-480);
  });

  it('returns null for malformed input', () => {
    expect(parseUtcOffset('05:30')).toBeNull();
    expect(parseUtcOffset('+5:30')).toBeNull();
    expect(parseUtcOffset('not-an-offset')).toBeNull();
  });

  it('handles UTC+00:00', () => {
    expect(parseUtcOffset('+00:00')).toBe(0);
    expect(parseUtcOffset('-00:00')).toBe(0);
  });
});

// ─── applyUtcOffset ──────────────────────────────────────────────────────────

describe('applyUtcOffset', () => {
  it('subtracts a positive offset to produce UTC (UTC+5 → 5 hours earlier)', () => {
    const utc = applyUtcOffset('2024-01-01T12:00:00', 300);
    expect(utc.toISOString()).toBe('2024-01-01T07:00:00.000Z');
  });

  it('adds back a negative offset to produce UTC (UTC-5 → 5 hours later)', () => {
    const utc = applyUtcOffset('2024-01-01T12:00:00', -300);
    expect(utc.toISOString()).toBe('2024-01-01T17:00:00.000Z');
  });

  it('returns the same instant for a zero offset', () => {
    const utc = applyUtcOffset('2024-06-15T09:30:00', 0);
    expect(utc.toISOString()).toBe('2024-06-15T09:30:00.000Z');
  });

  it('handles half-hour offsets (UTC+05:30 IST)', () => {
    const utc = applyUtcOffset('2024-06-15T09:30:00', 330);
    expect(utc.toISOString()).toBe('2024-06-15T04:00:00.000Z');
  });

  it('crosses day boundaries correctly going forward', () => {
    const utc = applyUtcOffset('2024-01-01T23:30:00', -300); // UTC-5
    expect(utc.toISOString()).toBe('2024-01-02T04:30:00.000Z');
  });

  it('crosses day boundaries correctly going backward', () => {
    const utc = applyUtcOffset('2024-01-01T02:00:00', 300); // UTC+5
    expect(utc.toISOString()).toBe('2023-12-31T21:00:00.000Z');
  });
});

// ─── formatDateInput / formatTimeInput ──────────────────────────────────────

describe('formatDateInput', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(formatDateInput(new Date('2024-03-15T14:30:00.000Z'))).toBe('2024-03-15');
  });

  it('handles year boundaries correctly', () => {
    expect(formatDateInput(new Date('2024-01-01T00:00:00.000Z'))).toBe('2024-01-01');
  });

  it('slices a wall-clock ISO string to YYYY-MM-DD', () => {
    expect(formatDateInput('2024-03-15T14:30:00')).toBe('2024-03-15');
  });
});

describe('formatTimeInput', () => {
  it('formats a UTC time as HH:MM', () => {
    expect(formatTimeInput(new Date('2024-03-15T14:30:00.000Z'))).toBe('14:30');
  });

  it('pads single-digit hours and minutes', () => {
    expect(formatTimeInput(new Date('2024-03-15T09:05:00.000Z'))).toBe('09:05');
  });

  it('slices a wall-clock ISO string to HH:MM', () => {
    expect(formatTimeInput('2024-03-15T14:30:00')).toBe('14:30');
  });
});

// ─── correctMagneticBearing ──────────────────────────────────────────────────
//
// These exercise the WMM2025 model that ships with the `geomagnetism` package.
// Reference declination values are from NOAA's WMM 2025 calculator. Locations
// span both hemispheres and include a near-zero-declination case (Eastern UK
// in 2026) and a high-declination case (eastern Australia).

describe('correctMagneticBearing', () => {
  const D = new Date('2026-05-22T00:00:00Z');

  it('adds an east-positive declination to convert magnetic to true bearing', () => {
    // Seattle (47.6°N, 122.3°W) has ~+15° declination in 2026.
    const result = correctMagneticBearing(100, { lat: 47.6, lng: -122.3 }, D);
    expect(result).not.toBeNull();
    expect(result!.declination).toBeGreaterThan(13);
    expect(result!.declination).toBeLessThan(17);
    expect(result!.trueBearing).toBeCloseTo(100 + result!.declination, 5);
  });

  it('returns a negative declination west of the agonic line', () => {
    // Sydney (-33.9°S, 151.2°E) has positive declination in 2026; pick somewhere
    // with negative declination instead — eastern South America (~Buenos Aires).
    const result = correctMagneticBearing(0, { lat: -34.6, lng: -58.4 }, D);
    expect(result).not.toBeNull();
    expect(result!.declination).toBeLessThan(0);
  });

  it('wraps the corrected bearing into [0, 360)', () => {
    // Force a wraparound: bearing 355°, +15° declination should yield ~10°.
    const result = correctMagneticBearing(355, { lat: 47.6, lng: -122.3 }, D);
    expect(result).not.toBeNull();
    expect(result!.trueBearing).toBeGreaterThanOrEqual(0);
    expect(result!.trueBearing).toBeLessThan(360);
    expect(result!.trueBearing).toBeLessThan(15);
  });

  it('returns null when given NaN inputs', () => {
    expect(correctMagneticBearing(NaN, { lat: 0, lng: 0 }, D)).toBeNull();
  });
});
