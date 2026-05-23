import { describe, it, expect, beforeAll } from 'vitest';
import * as SunCalc from 'suncalc';
import {
  calculateMeasurementsFromPixels,
  convertPercentageToPixels,
  applyAzimuthConstraint,
  analyzeShadowMeasurements,
  estimateBestLocation,
  generateShadowFinderGrid,
  computeLikelihood,
  dominantLatCluster,
  MAIN_BAND_RAD,
  VISIBLE_BAND_RAD,
  NIGHT_LIKELIHOOD,
  DEFAULT_AZIMUTH_TOLERANCE_DEG,
  type ShadowFinderPoint,
  type ShadowAnalysisResult,
} from './shadowfinder';

// ─── helpers ────────────────────────────────────────────────────────────────

function makePoint(sunAzimuthDeg: number, likelihood = 0.01): ShadowFinderPoint {
  return { lat: 0, lng: 0, likelihood, sunAzimuthDeg };
}

function makeResult(points: ShadowFinderPoint[]): ShadowAnalysisResult {
  return {
    points,
    mainBandCoordinates: { latRange: [0, 0], lngRange: [0, 0], lngWraps: false },
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
// The metric is the symmetric angular error |atan(h/s) − sunAlt| in radians.
// "Symmetric" here means swapping h and s (so the ratio inverts) gives the
// same error magnitude when reflected around π/4, because atan(x) + atan(1/x)
// = π/2 for x > 0.

describe('computeLikelihood', () => {
  const ALT_45 = Math.PI / 4;

  it('returns 0 when the shadow ratio exactly matches the sun altitude', () => {
    expect(computeLikelihood(100, 100, ALT_45)).toBeCloseTo(0);
  });

  it('returns the angular gap when the object is twice the shadow at 45°', () => {
    // atan(2) − π/4 ≈ 0.32175 rad
    const expected = Math.atan(2) - Math.PI / 4;
    expect(computeLikelihood(200, 100, ALT_45)).toBeCloseTo(expected, 10);
  });

  it('is symmetric: swapping object and shadow lengths gives the same likelihood at 45°', () => {
    // Old metric was asymmetric (2× shadow vs ½ shadow gave very different scores).
    // The angular metric reflects around π/4, so |atan(2) − π/4| = |atan(0.5) − π/4|.
    const a = computeLikelihood(200, 100, ALT_45);
    const b = computeLikelihood(100, 200, ALT_45);
    expect(a).toBeCloseTo(b, 10);
  });

  it('returns radians, not the old |ratio/tan(alt) − 1| value', () => {
    // Old metric at (200, 100, 45°) was exactly 1.0; new metric is ~0.32 rad.
    // This pins the change so a regression to the old formula fails loudly.
    expect(computeLikelihood(200, 100, ALT_45)).toBeLessThan(0.5);
  });
});

// ─── calculateMeasurementsFromPixels ────────────────────────────────────────

describe('calculateMeasurementsFromPixels', () => {
  it('measures a vertical object with a horizontal shadow', () => {
    const { objectHeight, shadowLength } = calculateMeasurementsFromPixels(
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      { x: 200, y: 100 },
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

// ─── exported constants ──────────────────────────────────────────────────────

describe('exported constants', () => {
  it('DEFAULT_AZIMUTH_TOLERANCE_DEG is a positive degree value', () => {
    expect(DEFAULT_AZIMUTH_TOLERANCE_DEG).toBeGreaterThan(0);
    expect(DEFAULT_AZIMUTH_TOLERANCE_DEG).toBeLessThan(45);
  });

  it('band thresholds are strictly ordered tightest → loosest', () => {
    // Required invariant for the band-counting hierarchy in analyzeShadowMeasurements.
    expect(MAIN_BAND_RAD).toBeGreaterThan(0);
    expect(VISIBLE_BAND_RAD).toBeGreaterThan(MAIN_BAND_RAD);
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
    const points = [makePoint(355), makePoint(5), makePoint(180)];
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 0, toleranceDeg: 10, enabled: true });
    expect(result).toHaveLength(2);
    expect(result.map(p => p.sunAzimuthDeg)).toContain(355);
    expect(result.map(p => p.sunAzimuthDeg)).toContain(5);
  });

  it('handles 0°/360° wraparound — bearing near 360°', () => {
    const points = [makePoint(350), makePoint(10)];
    const result = applyAzimuthConstraint(points, { sunBearingDeg: 355, toleranceDeg: 10, enabled: true });
    expect(result).toHaveLength(1);
    expect(result[0].sunAzimuthDeg).toBe(350);
  });

  it('includes a point exactly at the tolerance boundary', () => {
    const points = [makePoint(80), makePoint(100)];
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

  it('returns a mainBandCoordinates with lngWraps=false for a non-wrapping band', { timeout: 10000 }, () => {
    const result = analyzeShadowMeasurements({
      objectHeight: 100,
      shadowLength: 100,
      knownTime: new Date('2024-06-21T12:00:00.000Z'),
    });
    expect(result.mainBandCoordinates.lngWraps).toBe(false);
  });
});

// ─── estimateBestLocation ────────────────────────────────────────────────────

describe('estimateBestLocation', () => {
  it('throws when no points fall within the MAIN band', () => {
    const result = makeResult([makePoint(90, MAIN_BAND_RAD + 0.01), makePoint(180, 0.5)]);
    expect(() => estimateBestLocation(result)).toThrow('No suitable location matches found');
  });

  it('throws on an empty points array', () => {
    expect(() => estimateBestLocation(makeResult([]))).toThrow();
  });

  it('returns the coordinates of a single best point', () => {
    const points: ShadowFinderPoint[] = [
      { lat: 40, lng: -74, likelihood: 0.01, sunAzimuthDeg: 180 },
    ];
    const location = estimateBestLocation(makeResult(points));
    expect(location.latitude).toBeCloseTo(40);
    expect(location.longitude).toBeCloseTo(-74);
  });

  it('returns the centroid of multiple best points', () => {
    const points: ShadowFinderPoint[] = [
      { lat: 10, lng: 20, likelihood: 0.01, sunAzimuthDeg: 180 },
      { lat: 20, lng: 40, likelihood: 0.02, sunAzimuthDeg: 180 },
      // Outside MAIN band → excluded from the cluster.
      { lat: 90, lng: 90, likelihood: VISIBLE_BAND_RAD, sunAzimuthDeg: 90 },
    ];
    const location = estimateBestLocation(makeResult(points));
    expect(location.latitude).toBeCloseTo(15);
    expect(location.longitude).toBeCloseTo(30);
  });

  it('uses a circular mean for longitudes near the antimeridian', () => {
    // Plain arithmetic mean of -179 and 179 = 0 (deep wrong, on the opposite side of the globe).
    // Circular mean correctly produces ±180.
    const points: ShadowFinderPoint[] = [
      { lat: 0, lng: -179, likelihood: 0.01, sunAzimuthDeg: 90 },
      { lat: 0, lng: 179, likelihood: 0.01, sunAzimuthDeg: 90 },
    ];
    const location = estimateBestLocation(makeResult(points));
    expect(Math.abs(location.longitude)).toBeCloseTo(180, 1);
  });

  it('picks the larger cluster when posterior is bimodal in latitude', () => {
    // Three points clustered around lat=40 + one outlier at lat=-50 (gap = 90° > MIN_LAT_CLUSTER_GAP).
    // Centroid should reflect only the northern cluster.
    const points: ShadowFinderPoint[] = [
      { lat: 40, lng: 10, likelihood: 0.01, sunAzimuthDeg: 180 },
      { lat: 42, lng: 12, likelihood: 0.02, sunAzimuthDeg: 180 },
      { lat: 44, lng: 14, likelihood: 0.03, sunAzimuthDeg: 180 },
      { lat: -50, lng: 14, likelihood: 0.01, sunAzimuthDeg: 0 },
    ];
    const location = estimateBestLocation(makeResult(points));
    expect(location.latitude).toBeGreaterThan(35);
    expect(location.latitude).toBeLessThan(50);
  });

  it('returns at least half-cell grid resolution as the accuracy floor', () => {
    const points: ShadowFinderPoint[] = [
      { lat: 0, lng: 0, likelihood: 0, sunAzimuthDeg: 180 },
    ];
    const location = estimateBestLocation(makeResult(points));
    // half-cell at the equator = 0.25° × 111 km/° ≈ 27.75 km
    expect(location.accuracy).toBeGreaterThanOrEqual(27);
    expect(location.accuracy).toBeLessThan(30);
  });
});

// ─── dominantLatCluster ──────────────────────────────────────────────────────

describe('dominantLatCluster', () => {
  it('returns the input when there is no large gap', () => {
    const points = [{ lat: 10 }, { lat: 15 }, { lat: 20 }];
    expect(dominantLatCluster(points)).toHaveLength(3);
  });

  it('returns the input when single-point', () => {
    expect(dominantLatCluster([{ lat: 42 }])).toHaveLength(1);
  });

  it('splits a bimodal set and returns the larger cluster', () => {
    const points = [
      { lat: -40 }, { lat: -38 }, { lat: -36 }, // 3-pt south cluster
      { lat: 30 }, { lat: 32 }, // 2-pt north cluster (gap = 66°)
    ];
    const cluster = dominantLatCluster(points);
    expect(cluster).toHaveLength(3);
    for (const p of cluster) expect(p.lat).toBeLessThan(0);
  });

  it('treats two equal clusters by returning the southern half', () => {
    const points = [
      { lat: -40 }, { lat: -38 },
      { lat: 30 }, { lat: 32 },
    ];
    const cluster = dominantLatCluster(points);
    expect(cluster).toHaveLength(2);
    // Tie-break: south.length >= north.length picks south
    for (const p of cluster) expect(p.lat).toBeLessThan(0);
  });
});

// ─── generateShadowFinderGrid ────────────────────────────────────────────────

describe('generateShadowFinderGrid', () => {
  const GRID_TIME = new Date('2024-06-21T12:00:00.000Z');
  let points: ShadowFinderPoint[];

  beforeAll(() => {
    points = generateShadowFinderGrid(GRID_TIME, 100, 100);
  }, 15000);

  it('generates exactly 208,800 points covering the full grid', () => {
    expect(points).toHaveLength(208800);
  });

  it('keeps all lat/lng within the defined grid bounds', () => {
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual(-60);
      expect(p.lat).toBeLessThanOrEqual(84.5);
      expect(p.lng).toBeGreaterThanOrEqual(-180);
      expect(p.lng).toBeLessThanOrEqual(179.5);
    }
  });

  it('marks night points as NIGHT_LIKELIHOOD (-1) and day points as ≥ 0', () => {
    for (const p of points) {
      expect(p.likelihood === NIGHT_LIKELIHOOD || p.likelihood >= 0).toBe(true);
    }
  });

  it('keeps daytime sunAzimuthDeg in [0, 360) and leaves night cells as NaN', () => {
    for (const p of points) {
      if (p.likelihood === NIGHT_LIKELIHOOD) {
        // Azimuth is intentionally skipped on night cells (perf optimization).
        // NaN ensures applyAzimuthConstraint correctly excludes them.
        expect(Number.isNaN(p.sunAzimuthDeg)).toBe(true);
      } else {
        expect(p.sunAzimuthDeg).toBeGreaterThanOrEqual(0);
        expect(p.sunAzimuthDeg).toBeLessThan(360);
      }
    }
  });

  it('marks the equator at Greenwich Meridian as daytime at noon UTC', () => {
    const noonPoint = points.find(p => p.lat === 0 && p.lng === 0);
    expect(noonPoint).toBeDefined();
    expect(noonPoint!.likelihood).not.toBe(NIGHT_LIKELIHOOD);
  });

  it('marks the antimeridian (lng≈179.5) at the equator as nighttime at noon UTC', () => {
    const midnightPoint = points.find(p => p.lat === 0 && p.lng === 179.5);
    expect(midnightPoint).toBeDefined();
    expect(midnightPoint!.likelihood).toBe(NIGHT_LIKELIHOOD);
  });

  it('NaN-azimuth night cells are correctly excluded by applyAzimuthConstraint', () => {
    const filtered = applyAzimuthConstraint(points, {
      sunBearingDeg: 180,
      toleranceDeg: 90, // wide tolerance — would match many daytime cells
      enabled: true,
    });
    // None of the survivors should be night cells.
    for (const p of filtered) {
      expect(p.likelihood).not.toBe(NIGHT_LIKELIHOOD);
    }
  });

  it('with an azimuth constraint, marks cells outside tolerance as NIGHT_LIKELIHOOD', () => {
    // Very tight tolerance — only a narrow strip should keep a valid likelihood.
    const constrained = generateShadowFinderGrid(GRID_TIME, 100, 100, {
      sunBearingDeg: 180,
      toleranceDeg: 2,
      enabled: true,
    });
    let valid = 0;
    let rejected = 0;
    for (const p of constrained) {
      if (p.likelihood === NIGHT_LIKELIHOOD) rejected++;
      else valid++;
    }
    // Far more cells should be rejected than kept under a 2° tolerance.
    expect(rejected).toBeGreaterThan(valid * 5);
    // Surviving cells should all be near the target bearing.
    for (const p of constrained) {
      if (p.likelihood !== NIGHT_LIKELIHOOD) {
        const diff = Math.abs(((p.sunAzimuthDeg - 180 + 540) % 360) - 180);
        expect(diff).toBeLessThanOrEqual(2);
      }
    }
  });

  it('with disabled azimuth constraint, behaves identically to no constraint', () => {
    const constrained = generateShadowFinderGrid(GRID_TIME, 100, 100, {
      sunBearingDeg: 180,
      toleranceDeg: 5,
      enabled: false,
    });
    // Sample-equality check — full equality of 200K points would be slow.
    for (let i = 0; i < constrained.length; i += 5000) {
      expect(constrained[i].likelihood).toBe(points[i].likelihood);
    }
  });

  it('matches SunCalc altitude/azimuth at sampled grid points (parity check)', () => {
    // The inlined sun-position math should agree with SunCalc to within rounding.
    // We sample across latitudes/longitudes and times to catch any drift.
    const samples: Array<{ lat: number; lng: number }> = [
      { lat: 0, lng: 0 },
      { lat: 45, lng: -75 },
      { lat: -33.5, lng: 151 },
      { lat: 84.5, lng: 179.5 },
      { lat: -60, lng: -180 },
      { lat: 23.5, lng: 100 },
    ];
    for (const s of samples) {
      const p = points.find(pt => pt.lat === s.lat && pt.lng === s.lng);
      expect(p).toBeDefined();
      const ref = SunCalc.getPosition(GRID_TIME, s.lat, s.lng);
      if (ref.altitude > 0) {
        const expectedLikelihood = Math.abs(Math.atan(1) - ref.altitude);
        expect(p!.likelihood).toBeCloseTo(expectedLikelihood, 6);
        const refAzimuthDeg = ((ref.azimuth * 180) / Math.PI + 540) % 360;
        expect(p!.sunAzimuthDeg).toBeCloseTo(refAzimuthDeg, 6);
      } else {
        expect(p!.likelihood).toBe(NIGHT_LIKELIHOOD);
        // Azimuth is intentionally skipped for night cells.
        expect(Number.isNaN(p!.sunAzimuthDeg)).toBe(true);
      }
    }
  });
});
