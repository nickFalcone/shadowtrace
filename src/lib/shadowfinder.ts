/**
 * ShadowFinder Algorithm — TypeScript Implementation
 *
 * OSINT geolocation by matching the measured shadow-to-object ratio against
 * the sun's altitude at every point on a 0.5° world grid. Inspired by Bellingcat's
 * ShadowFinder, with two intentional differences:
 *
 *   1. Likelihood is the symmetric angular error
 *        |atan(height / shadow) − sun_altitude|
 *      in radians, not Bellingcat's asymmetric |ratio / tan(alt) − 1|. This
 *      makes the band thresholds physically meaningful (sun-altitude error
 *      in radians) and treats over- and under-measurements of shadow length
 *      identically.
 *
 *   2. Sun-position math is inlined here. Time-only terms (declination,
 *      right ascension, GMST) are computed once per grid; longitude trig is
 *      cached in a Float64Array shared across latitudes. Verified against
 *      SunCalc in tests within 1e-6 rad.
 */

// ── Constants ───────────────────────────────────────────────────────────────

const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD_PER_DEG * 23.4397;

const LAT_MIN = -60;
const LNG_MIN = -180;
const GRID_RES_DEG = 0.5;
const LAT_STEPS = 290; // -60.0 .. 84.5 inclusive
const LNG_STEPS = 720; // -180.0 .. 179.5 inclusive
const GRID_COUNT = LAT_STEPS * LNG_STEPS;
const EARTH_RADIUS_KM = 6371;
/** Rough conversion from degrees of latitude to kilometers (≈ Earth circumference / 360°). */
const KM_PER_DEG_LAT = 111;

/**
 * Likelihood thresholds in radians of sun-altitude error.
 *
 *   ULTRA_TIGHT ≈ 1.43°    TIGHT ≈ 2.29°
 *   MAIN        ≈ 2.86°    VISIBLE ≈ 4.30°
 *
 * Tuned to roughly match the band sizes of the older
 * |ratio/tan(alt) − 1| ≤ {0.05, 0.08, 0.10, 0.15} thresholds at typical
 * mid-latitude altitudes.
 */
export const ULTRA_TIGHT_BAND_RAD = 0.025;
export const TIGHT_BAND_RAD = 0.04;
export const MAIN_BAND_RAD = 0.05;
export const VISIBLE_BAND_RAD = 0.075;

/** Sentinel for grid points that don't have a valid likelihood (sun below horizon,
 *  or — when the grid is generated with an azimuth constraint — outside its tolerance). */
export const NIGHT_LIKELIHOOD = -1;

/** Default tolerance applied by the UI when wiring up an azimuth constraint. */
export const DEFAULT_AZIMUTH_TOLERANCE_DEG = 10;

/** Percentile of the great-circle distance distribution used as the "accuracy" radius. */
const ACCURACY_PERCENTILE = 0.68;

// Minimum lat gap (degrees) that triggers bimodal-posterior splitting. Shadow
// solutions usually come as one northern + one southern crescent separated by
// a clear gap — anything below this is treated as a single cluster.
const MIN_LAT_CLUSTER_GAP_DEG = 20;

// ── Public types ────────────────────────────────────────────────────────────

export interface ShadowFinderPoint {
  lat: number;
  lng: number;
  /** Radians of angular error between measured and predicted sun altitude, or NIGHT_LIKELIHOOD (-1) for night points. */
  likelihood: number;
  /** Sun's compass bearing at this grid point, in degrees [0, 360), 0 = North. */
  sunAzimuthDeg: number;
}

export interface ShadowAnalysisInput {
  objectHeight: number;
  shadowLength: number;
  knownTime: Date;
}

export interface ShadowAnalysisResult {
  points: ShadowFinderPoint[];
  /**
   * Bounding box of the dominant solution cluster (after splitting bimodal
   * north/south posteriors). When `lngWraps` is true, the band crosses the
   * antimeridian; `lngRange[0]` is the eastern edge and `lngRange[1]` is the
   * western edge (so `lngRange[0] > lngRange[1]`).
   */
  mainBandCoordinates: {
    latRange: [number, number];
    lngRange: [number, number];
    lngWraps: boolean;
  };
  statistics: {
    totalPoints: number;
    validPoints: number;
    nightPoints: number;
    ultraTightBandPoints: number;
    tightBandPoints: number;
    visibleBandPoints: number;
  };
}

// ── Sun position ────────────────────────────────────────────────────────────

interface SunDayConstants {
  sinDec: number;
  cosDec: number;
  tanDec: number;
  ra: number; // right ascension (rad)
  gmst: number; // Greenwich mean sidereal time at this instant (rad)
}

/**
 * Precompute the time-only sun parameters. Formulas from the Astronomical
 * Almanac, identical to those used by SunCalc — we just split them out so the
 * grid loop pays the cost once instead of 208,800 times.
 */
function precomputeSun(time: Date): SunDayConstants {
  const d = time.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const M = RAD_PER_DEG * (357.5291 + 0.98560028 * d);
  const C = RAD_PER_DEG * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD_PER_DEG * 102.9372 + Math.PI;
  const sinL = Math.sin(L);
  const cosL = Math.cos(L);
  const sinE = Math.sin(OBLIQUITY);
  const cosE = Math.cos(OBLIQUITY);
  const dec = Math.asin(sinL * sinE);
  const ra = Math.atan2(sinL * cosE, cosL);
  const gmst = RAD_PER_DEG * (280.16 + 360.9856235 * d);
  return {
    sinDec: Math.sin(dec),
    cosDec: Math.cos(dec),
    tanDec: Math.tan(dec),
    ra,
    gmst,
  };
}

// ── Public functions ────────────────────────────────────────────────────────

/**
 * Symmetric angular error between the sun altitude implied by the measured
 * shadow ratio and the sun altitude predicted at a grid point.
 *
 *   likelihood = |atan(height / shadow) − sunAltitudeRad|
 *
 * Lower = better fit; 0 = perfect. Swapping the roles of height and shadow
 * at altitude α produces the same error around π/4 because atan(x) and
 * atan(1/x) are reflections across π/4.
 *
 * Only meaningful when sunAltitudeRad > 0 (daytime).
 */
export function computeLikelihood(
  objectHeight: number,
  shadowLength: number,
  sunAltitudeRad: number,
): number {
  return Math.abs(Math.atan(objectHeight / shadowLength) - sunAltitudeRad);
}

/**
 * Generate the full 290 × 720 = 208,800-point world grid for a given instant.
 * Each point carries either an angular-error likelihood (sun above horizon) or
 * `NIGHT_LIKELIHOOD` (-1) when the sun is below the horizon — or, when an
 * `azimuthConstraint` is provided, when the sun's azimuth at that cell is
 * outside the constraint's tolerance.
 *
 * Optimizations:
 *   - `Math.atan2` for sun azimuth is skipped on night cells (saves ~50% of
 *     atan2 calls). The `sunAzimuthDeg` field is set to NaN on those cells;
 *     `applyAzimuthConstraint` correctly excludes them because NaN comparisons
 *     are always false.
 *   - When `azimuthConstraint` is provided, azimuth is computed first and cells
 *     outside tolerance are marked `NIGHT_LIKELIHOOD` immediately — skipping
 *     the `Math.asin` altitude resolution for ~95% of cells in typical use.
 *     CAVEAT: callers that rely on the "no-match fallback" in the visualization
 *     (showing the full shadow band when the constraint excludes everything)
 *     must NOT pass the constraint here.
 */
export function generateShadowFinderGrid(
  knownTime: Date,
  objectHeight: number,
  shadowLength: number,
  azimuthConstraint?: AzimuthConstraint | null,
): ShadowFinderPoint[] {
  const sun = precomputeSun(knownTime);
  const measuredAlt = Math.atan(objectHeight / shadowLength);

  // Hour angle H depends on longitude only: H = gmst + lng·rad − ra. Both
  // altitude and azimuth formulas use only sin(H) and cos(H), so caching them
  // per longitude column saves one sin and one cos per cell (≈ 200K × 2 = 400K
  // trig calls per analysis).
  const sinH = new Float64Array(LNG_STEPS);
  const cosH = new Float64Array(LNG_STEPS);
  for (let j = 0; j < LNG_STEPS; j++) {
    const H = sun.gmst + (LNG_MIN + j * GRID_RES_DEG) * RAD_PER_DEG - sun.ra;
    sinH[j] = Math.sin(H);
    cosH[j] = Math.cos(H);
  }

  const points = new Array<ShadowFinderPoint>(GRID_COUNT);
  let idx = 0;

  const constraintActive = !!azimuthConstraint?.enabled;
  const targetBearing = azimuthConstraint?.sunBearingDeg ?? 0;
  const tolerance = azimuthConstraint?.toleranceDeg ?? 0;

  for (let i = 0; i < LAT_STEPS; i++) {
    const lat = LAT_MIN + i * GRID_RES_DEG;
    const phi = lat * RAD_PER_DEG;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const sinPhiSinDec = sinPhi * sun.sinDec;
    const cosPhiCosDec = cosPhi * sun.cosDec;
    const tanDecCosPhi = sun.tanDec * cosPhi;

    for (let j = 0; j < LNG_STEPS; j++) {
      const lng = LNG_MIN + j * GRID_RES_DEG;
      const sH = sinH[j];
      const cH = cosH[j];

      const sinAlt = sinPhiSinDec + cosPhiCosDec * cH;

      // Fast path for night points: skip both Math.asin (altitude) and
      // Math.atan2 (azimuth). NaN azimuth ensures applyAzimuthConstraint
      // excludes these cells (comparison with NaN is always false).
      if (sinAlt <= 0) {
        points[idx++] = { lat, lng, likelihood: NIGHT_LIKELIHOOD, sunAzimuthDeg: NaN };
        continue;
      }

      // SunCalc azimuth convention: 0 = South, positive = West, radians.
      // Compass bearing: ((az · 180/π) + 180 + 360) mod 360 → 0 = North, CW.
      const azimuthRad = Math.atan2(sH, cH * sinPhi - tanDecCosPhi);
      const sunAzimuthDeg = (azimuthRad * DEG_PER_RAD + 540) % 360;

      // When a constraint is baked in at generation time, reject cells outside
      // tolerance BEFORE paying for the altitude asin. Same wrap-aware delta
      // math as applyAzimuthConstraint.
      if (constraintActive) {
        const diff = Math.abs(((sunAzimuthDeg - targetBearing + 540) % 360) - 180);
        if (diff > tolerance) {
          points[idx++] = { lat, lng, likelihood: NIGHT_LIKELIHOOD, sunAzimuthDeg };
          continue;
        }
      }

      const likelihood = Math.abs(measuredAlt - Math.asin(sinAlt));
      points[idx++] = { lat, lng, likelihood, sunAzimuthDeg };
    }
  }

  return points;
}

export interface ShadowAnalysisOptions {
  /**
   * If provided and enabled, the grid generation pre-filters by sun azimuth
   * (skipping the per-cell `Math.asin` for ~95% of cells in typical use).
   *
   * CAVEAT: callers relying on the "no-match fallback" — showing the full
   * shadow band when the constraint excludes everything — must NOT pass the
   * constraint here, because the full band won't exist in the result. The
   * production callsite in `Index.tsx` leaves this unset and applies the
   * constraint client-side via `applyAzimuthConstraint` instead.
   */
  azimuthConstraint?: AzimuthConstraint | null;
}

/**
 * Analyze shadow measurements and generate location possibilities.
 */
export function analyzeShadowMeasurements(
  input: ShadowAnalysisInput,
  options?: ShadowAnalysisOptions,
): ShadowAnalysisResult {
  if (input.objectHeight <= 0 || input.shadowLength <= 0) {
    throw new Error('Invalid measurements: object height and shadow length must be positive');
  }
  if (isNaN(input.knownTime.getTime())) {
    throw new Error('Invalid date/time provided');
  }

  const points = generateShadowFinderGrid(
    input.knownTime,
    input.objectHeight,
    input.shadowLength,
    options?.azimuthConstraint,
  );

  let nightPoints = 0;
  let validPoints = 0;
  let ultraTightBandPoints = 0;
  let tightBandPoints = 0;
  let visibleBandPoints = 0;
  const mainBand: Array<{ lat: number; lng: number }> = [];

  for (const p of points) {
    const l = p.likelihood;
    if (l === NIGHT_LIKELIHOOD) {
      nightPoints++;
      continue;
    }
    validPoints++;
    if (l <= ULTRA_TIGHT_BAND_RAD) ultraTightBandPoints++;
    if (l <= TIGHT_BAND_RAD) tightBandPoints++;
    if (l <= VISIBLE_BAND_RAD) visibleBandPoints++;
    if (l <= MAIN_BAND_RAD) mainBand.push({ lat: p.lat, lng: p.lng });
  }

  return {
    points,
    mainBandCoordinates: computeMainBandBbox(mainBand),
    statistics: {
      totalPoints: points.length,
      validPoints,
      nightPoints,
      ultraTightBandPoints,
      tightBandPoints,
      visibleBandPoints,
    },
  };
}

/**
 * Calculate object height and shadow length from pixel coordinates.
 */
export function calculateMeasurementsFromPixels(
  objectBottom: { x: number; y: number },
  objectTop: { x: number; y: number },
  shadowTip: { x: number; y: number },
): { objectHeight: number; shadowLength: number } {
  const objectHeight = Math.sqrt(
    Math.pow(objectTop.x - objectBottom.x, 2) + Math.pow(objectTop.y - objectBottom.y, 2),
  );
  const shadowLength = Math.sqrt(
    Math.pow(shadowTip.x - objectBottom.x, 2) + Math.pow(shadowTip.y - objectBottom.y, 2),
  );
  return { objectHeight, shadowLength };
}

/**
 * Convert percentage-based coordinates to absolute pixel coordinates.
 */
export function convertPercentageToPixels(
  percentageCoords: { x: number; y: number },
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  return {
    x: (percentageCoords.x / 100) * imageWidth,
    y: (percentageCoords.y / 100) * imageHeight,
  };
}

export interface AzimuthConstraint {
  sunBearingDeg: number;
  toleranceDeg: number;
  enabled: boolean;
}

/**
 * Filter grid points to those whose sun azimuth is within toleranceDeg of the
 * observed sun bearing. Handles the 0°/360° wraparound.
 */
export function applyAzimuthConstraint(
  points: ShadowFinderPoint[],
  constraint: AzimuthConstraint,
): ShadowFinderPoint[] {
  if (!constraint.enabled) return points;
  return points.filter((p) => {
    const diff = Math.abs(((p.sunAzimuthDeg - constraint.sunBearingDeg + 540) % 360) - 180);
    return diff <= constraint.toleranceDeg;
  });
}

/**
 * Estimate the best possible location from analysis results.
 *
 * Resolves bimodal posteriors by splitting on the largest latitude gap, then
 * computes a circular-mean centroid (correct across the antimeridian) and a
 * 68th-percentile great-circle distance as the "accuracy" radius.
 */
export function estimateBestLocation(result: ShadowAnalysisResult): {
  latitude: number;
  longitude: number;
  accuracy: number;
} {
  const bestPoints = result.points.filter(
    (p) => p.likelihood >= 0 && p.likelihood <= MAIN_BAND_RAD,
  );
  if (bestPoints.length === 0) {
    throw new Error('No suitable location matches found');
  }

  const cluster = dominantLatCluster(bestPoints);

  // Circular mean of longitudes — averaging unit vectors on the lng circle
  // gives the right answer at the ±180° seam (e.g. lng=-179 and lng=179 → ±180,
  // not 0).
  let sumLat = 0;
  let sumLngX = 0;
  let sumLngY = 0;
  for (const p of cluster) {
    sumLat += p.lat;
    const lngRad = p.lng * RAD_PER_DEG;
    sumLngX += Math.cos(lngRad);
    sumLngY += Math.sin(lngRad);
  }
  const avgLat = sumLat / cluster.length;
  const avgLng = Math.atan2(sumLngY, sumLngX) * DEG_PER_RAD;

  // 68th-percentile great-circle distance is more robust than min/max spread
  // because it ignores outliers and degrades gracefully on single-point clusters.
  // Floor at half the grid resolution at the equator — a 0.5° grid simply
  // cannot resolve finer than half a cell (~28 km).
  const distances = cluster
    .map((p) => greatCircleKm(avgLat, avgLng, p.lat, p.lng))
    .sort((a, b) => a - b);
  const pIdx = Math.min(distances.length - 1, Math.floor(distances.length * ACCURACY_PERCENTILE));
  const halfCellKm = (GRID_RES_DEG / 2) * KM_PER_DEG_LAT;
  const accuracy = Math.max(distances[pIdx], halfCellKm);

  return { latitude: avgLat, longitude: avgLng, accuracy };
}

// ── Internal helpers (exported for tests) ───────────────────────────────────

/**
 * Pick the larger of the two latitudinal clusters when there's a clear gap;
 * otherwise return the input. Operates on a sorted copy and runs in O(n log n).
 */
export function dominantLatCluster<T extends { lat: number }>(points: T[]): T[] {
  if (points.length <= 1) return points;
  const sorted = [...points].sort((a, b) => a.lat - b.lat);
  let largestGap = 0;
  let gapIdx = -1;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].lat - sorted[i - 1].lat;
    if (g > largestGap) {
      largestGap = g;
      gapIdx = i;
    }
  }
  if (largestGap < MIN_LAT_CLUSTER_GAP_DEG || gapIdx <= 0) return sorted;
  const south = sorted.slice(0, gapIdx);
  const north = sorted.slice(gapIdx);
  return south.length >= north.length ? south : north;
}

function computeMainBandBbox(
  band: Array<{ lat: number; lng: number }>,
): ShadowAnalysisResult['mainBandCoordinates'] {
  if (band.length === 0) {
    return { latRange: [0, 0], lngRange: [0, 0], lngWraps: false };
  }

  const dominant = dominantLatCluster(band);

  let minLat = Infinity;
  let maxLat = -Infinity;
  const lngs: number[] = [];
  for (const p of dominant) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    lngs.push(p.lng);
  }

  const { lngRange, wraps } = lngBboxWithWrap(lngs);
  return { latRange: [minLat, maxLat], lngRange, lngWraps: wraps };
}

/**
 * Tight lng bbox that respects the antimeridian. Strategy: sort the lngs, find
 * the largest empty arc (including the wraparound arc from max back to min),
 * and the cluster spans from the point AFTER the gap to the point BEFORE it.
 * If the chosen gap is the wrap arc, the band does not wrap; otherwise it does.
 */
function lngBboxWithWrap(lngs: number[]): { lngRange: [number, number]; wraps: boolean } {
  const sorted = [...lngs].sort((a, b) => a - b);
  const n = sorted.length;
  let largestGap = sorted[0] + 360 - sorted[n - 1];
  let gapStartIdx = n - 1;
  for (let i = 1; i < n; i++) {
    const g = sorted[i] - sorted[i - 1];
    if (g > largestGap) {
      largestGap = g;
      gapStartIdx = i - 1;
    }
  }
  const start = sorted[(gapStartIdx + 1) % n];
  const end = sorted[gapStartIdx];
  return { lngRange: [start, end], wraps: start > end };
}

function greatCircleKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = lat1 * RAD_PER_DEG;
  const phi2 = lat2 * RAD_PER_DEG;
  const dPhi = (lat2 - lat1) * RAD_PER_DEG;
  const dLambda = (lng2 - lng1) * RAD_PER_DEG;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
