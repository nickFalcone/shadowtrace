import { describe, it, expect } from 'vitest';
import {
  calculateMeasurementsFromPixels,
  convertPercentageToPixels,
  applyAzimuthConstraint,
  analyzeShadowMeasurements,
  estimateBestLocation,
  generateShadowFinderGrid,
  computeLikelihood,
  type ShadowFinderPoint,
  type ShadowAnalysisResult,
} from './shadowfinder';

// ─── helpers ────────────────────────────────────────────────────────────────

function makePoint(sunAzimuthDeg: number, likelihood = 0.05): ShadowFinderPoint {
  return { lat: 0, lng: 0, likelihood, sunAzimuthDeg };
}

function makeResult(points: ShadowFinderPoint[]): ShadowAnalysisResult {
  return {
    points,
    mainBandCoordinates: { latRange: [0, 0], lngRange: [0, 0] },
    statistics: {
      totalPoints: points.length,
      validPoints: points.length,
      nightPoints: 0,
      ultraTightBandPoints: 0,
      tightBandPoints: 0,
      visibleBandPoints: 0,
    },
  };
}

// ─── computeLikelihood ───────────────────────────────────────────────────────
//
// These tests pin the exact formula. An accidental inversion (1/(ratio*tan) instead
// of ratio/tan) changes all non-zero results and would fail the asymmetric cases.

describe('computeLikelihood', () => {
  const ALT_45 = Math.PI / 4; // tan(45°) = 1 — simplifies expected values

  it('returns 0 when the shadow ratio exactly matches the sun altitude', () => {
    // objectHeight/shadowLength = 1 = tan(45°), perfect match
    expect(computeLikelihood(100, 100, ALT_45)).toBeCloseTo(0);
  });

  it('returns 1 when the object is twice the shadow length at 45°', () => {
    // ratio = 2, tan(45°) = 1 → |2/1 - 1| = 1.0
    expect(computeLikelihood(200, 100, ALT_45)).toBeCloseTo(1.0);
  });

  it('returns 0.5 when the shadow is twice the object length at 45°', () => {
    // ratio = 0.5, tan(45°) = 1 → |0.5/1 - 1| = 0.5
    // An inverted formula gives |1/(1*0.5) - 1| = 1.0 — catches the bug
    expect(computeLikelihood(100, 200, ALT_45)).toBeCloseTo(0.5);
  });

  it('is asymmetric: swapping object and shadow lengths gives different results', () => {
    const a = computeLikelihood(200, 100, ALT_45); // ratio 2 → 1.0
    const b = computeLikelihood(100, 200, ALT_45); // ratio 0.5 → 0.5
    expect(a).not.toBeCloseTo(b);
  });
});

// ─── calculateMeasurementsFromPixels ────────────────────────────────────────

describe('calculateMeasurementsFromPixels', () => {
  it('measures a vertical object with a horizontal shadow', () => {
    const { objectHeight, shadowLength } = calculateMeasurementsFromPixels(
      { x: 100, y: 100 },  // base
      { x: 100, y: 0 },    // top (directly above)
      { x: 200, y: 100 },  // shadow tip (directly right)
    );
    expect(objectHeight).toBeCloseTo(100);
    expect(shadowLength).toBeCloseTo(100);
  });

  it('computes diagonal distances using Euclidean geometry (3-4-5 triangle)', () => {
    const { objectHeight, shadowLength } = calculateMeasurementsFromPixels(
      { x: 0, y: 4 },
      { x: 3, y: 0 },
      { x: 4, y: 4 },
    );
    expect(objectHeight).toBeCloseTo(5);
    expect(shadowLength).toBeCloseTo(4);
  });

  it('returns zero when all points coincide', () => {
    const { objectHeight, shadowLength } = calculateMeasurementsFromPixels(
      { x: 50, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 50 },
    );
    expect(objectHeight).toBe(0);
    expect(shadowLength).toBe(0);
  });
});

// ─── convertPercentageToPixels ───────────────────────────────────────────────

describe('convertPercentageToPixels', () => {
  it('converts 50% to half the image dimensions', () => {
    const result = convertPercentageToPixels({ x: 50, y: 50 }, 800, 600);
    expect(result).toEqual({ x: 400, y: 300 });
  });

  it('converts 100% to the full image dimensions', () => {
    const result = convertPercentageToPixels({ x: 100, y: 100 }, 1920, 1080);
    expect(result).toEqual({ x: 1920, y: 1080 });
  });

  it('converts 0% to the origin', () => {
    const result = convertPercentageToPixels({ x: 0, y: 0 }, 800, 600);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('handles non-square images independently per axis', () => {
    const result = convertPercentageToPixels({ x: 25, y: 75 }, 400, 200);
    expect(result).toEqual({ x: 100, y: 150 });
  });
});

// ─── applyAzimuthConstraint ──────────────────────────────────────────────────

describe('applyAzimuthConstraint', () => {
  it('returns all points unchanged when disabled', () => {
    const points = [makePoint(90), makePoint(180), makePoint(270)];
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 90, toleranceDeg: 5, enabled: false });
    expect(result).toHaveLength(3);
  });

  it('keeps points within tolerance', () => {
    const points = [makePoint(85), makePoint(90), makePoint(95)];
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 90, toleranceDeg: 10, enabled: true });
    expect(result).toHaveLength(3);
  });

  it('excludes points outside tolerance', () => {
    const points = [makePoint(80), makePoint(90), makePoint(101)];
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 90, toleranceDeg: 5, enabled: true });
    expect(result).toHaveLength(1);
    expect(result[0].sunAzimuthDeg).toBe(90);
  });

  it('handles 0°/360° wraparound — points near 0° match a bearing near 0°', () => {
    // 355° and 5° are both 5° away from 0°; 180° is 180° away
    const points = [makePoint(355), makePoint(5), makePoint(180)];
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 0, toleranceDeg: 10, enabled: true });
    expect(result).toHaveLength(2);
    expect(result.map(p => p.sunAzimuthDeg)).toContain(355);
    expect(result.map(p => p.sunAzimuthDeg)).toContain(5);
  });

  it('handles 0°/360° wraparound — bearing near 360°', () => {
    // 350° is 5° from 355°; 10° is 15° from 355° → excluded
    const points = [makePoint(350), makePoint(10)];
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 355, toleranceDeg: 10, enabled: true });
    expect(result).toHaveLength(1);
    expect(result[0].sunAzimuthDeg).toBe(350);
  });

  it('includes a point exactly at the tolerance boundary', () => {
    const points = [makePoint(80), makePoint(100)]; // both exactly 10° from 90°
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 90, toleranceDeg: 10, enabled: true });
    expect(result).toHaveLength(2);
  });
});

// ─── analyzeShadowMeasurements ───────────────────────────────────────────────

describe('analyzeShadowMeasurements', () => {
  it('throws on zero object height', () => {
    expect(() =>
      analyzeShadowMeasurements({ objectHeight: 0, shadowLength: 100, knownTime: new Date() })
    ).toThrow('Invalid measurements');
  });

  it('throws on negative object height', () => {
    expect(() =>
      analyzeShadowMeasurements({ objectHeight: -1, shadowLength: 100, knownTime: new Date() })
    ).toThrow('Invalid measurements');
  });

  it('throws on zero shadow length', () => {
    expect(() =>
      analyzeShadowMeasurements({ objectHeight: 100, shadowLength: 0, knownTime: new Date() })
    ).toThrow('Invalid measurements');
  });

  it('throws on an invalid Date', () => {
    expect(() =>
      analyzeShadowMeasurements({ objectHeight: 100, shadowLength: 100, knownTime: new Date('not-a-date') })
    ).toThrow('Invalid date');
  });

  it('returns a well-formed result with correct structure', { timeout: 10000 }, () => {
    const result = analyzeShadowMeasurements({
      objectHeight: 100,
      shadowLength: 100,
      knownTime: new Date('2024-06-21T12:00:00.000Z'),
    });

    expect(result.points.length).toBe(208800);
    expect(result.statistics.totalPoints).toBe(208800);
    expect(result.statistics.nightPoints + result.statistics.validPoints).toBe(208800);
    expect(result.statistics.ultraTightBandPoints).toBeLessThanOrEqual(result.statistics.tightBandPoints);
    expect(result.statistics.tightBandPoints).toBeLessThanOrEqual(result.statistics.visibleBandPoints);
  });
});

// ─── estimateBestLocation ────────────────────────────────────────────────────

describe('estimateBestLocation', () => {
  it('throws when no points have likelihood ≤ 0.1', () => {
    const result = makeResult([makePoint(90, 0.2), makePoint(180, 0.5)]);
    expect(() => estimateBestLocation(result)).toThrow('No suitable location matches found');
  });

  it('throws on an empty points array', () => {
    expect(() => estimateBestLocation(makeResult([]))).toThrow();
  });

  it('returns the coordinates of a single best point', () => {
    const points: ShadowFinderPoint[] = [
      { lat: 40, lng: -74, likelihood: 0.05, sunAzimuthDeg: 180 },
    ];
    const location = estimateBestLocation(makeResult(points));
    expect(location.latitude).toBeCloseTo(40);
    expect(location.longitude).toBeCloseTo(-74);
  });

  it('returns the centroid of multiple best points', () => {
    const points: ShadowFinderPoint[] = [
      { lat: 10, lng: 20, likelihood: 0.02, sunAzimuthDeg: 180 },
      { lat: 20, lng: 40, likelihood: 0.04, sunAzimuthDeg: 180 },
      // likelihood > 0.1, excluded from best
      { lat: 90, lng: 90, likelihood: 0.15, sunAzimuthDeg: 90 },
    ];
    const location = estimateBestLocation(makeResult(points));
    expect(location.latitude).toBeCloseTo(15);
    expect(location.longitude).toBeCloseTo(30);
  });

  it('returns at least 1km accuracy', () => {
    const points: ShadowFinderPoint[] = [
      { lat: 0, lng: 0, likelihood: 0, sunAzimuthDeg: 180 },
    ];
    const location = estimateBestLocation(makeResult(points));
    expect(location.accuracy).toBeGreaterThanOrEqual(1);
  });
});

// ─── generateShadowFinderGrid ────────────────────────────────────────────────

describe('generateShadowFinderGrid', () => {
  // Grid is 290 latitudes × 720 longitudes = 208,800 points.
  // This test calls SunCalc ~200k times and takes ~1–2 seconds.
  const GRID_TIME = new Date('2024-06-21T12:00:00.000Z');

  it('generates exactly 208,800 points covering the full grid', { timeout: 10000 }, () => {
    const points = generateShadowFinderGrid(GRID_TIME, 100, 100);
    expect(points).toHaveLength(208800);
  });

  it('keeps all lat/lng within the defined grid bounds', { timeout: 10000 }, () => {
    const points = generateShadowFinderGrid(GRID_TIME, 100, 100);
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual(-60);
      expect(p.lat).toBeLessThanOrEqual(84.5);
      expect(p.lng).toBeGreaterThanOrEqual(-180);
      expect(p.lng).toBeLessThanOrEqual(179.5);
    }
  });

  it('marks night points as -1 and day points as ≥ 0', { timeout: 10000 }, () => {
    const points = generateShadowFinderGrid(GRID_TIME, 100, 100);
    for (const p of points) {
      expect(p.likelihood === -1 || p.likelihood >= 0).toBe(true);
    }
  });

  it('keeps all sunAzimuthDeg in [0, 360)', { timeout: 10000 }, () => {
    const points = generateShadowFinderGrid(GRID_TIME, 100, 100);
    for (const p of points) {
      expect(p.sunAzimuthDeg).toBeGreaterThanOrEqual(0);
      expect(p.sunAzimuthDeg).toBeLessThan(360);
    }
  });

  it('marks the equator at Greenwich Meridian as daytime at noon UTC', { timeout: 10000 }, () => {
    const points = generateShadowFinderGrid(GRID_TIME, 100, 100);
    const noonPoint = points.find(p => p.lat === 0 && p.lng === 0);
    expect(noonPoint).toBeDefined();
    expect(noonPoint!.likelihood).not.toBe(-1);
  });

  it('marks the antimeridian (lng≈179.5) at the equator as nighttime at noon UTC', { timeout: 10000 }, () => {
    const points = generateShadowFinderGrid(GRID_TIME, 100, 100);
    const midnightPoint = points.find(p => p.lat === 0 && p.lng === 179.5);
    expect(midnightPoint).toBeDefined();
    expect(midnightPoint!.likelihood).toBe(-1);
  });
});
