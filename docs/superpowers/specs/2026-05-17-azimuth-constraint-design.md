# Azimuth Constraint + Loupe Magnifier Design

**Date:** 2026-05-17
**Branch:** feature/exif-compass-azimuth
**Status:** Approved

## Problem

The shadow length analysis produces a latitude band that spans the entire globe. The compass bearing extracted from EXIF in the previous feature is stored in state but unused. Using it to compute the sun's azimuth provides a second independent constraint that cuts the result from a band to a candidate region.

Separately, precise placement of the shadow tip point on the image directly affects azimuth accuracy. A loupe magnifier reduces marking error from ~5px to ~1px.

## Goal

1. Add a CSS loupe magnifier to `InteractiveImage` for precise point placement.
2. Compute the sun azimuth from the camera bearing + shadow pixel direction and expose it as a toggleable post-analysis filter in `AnalysisPanel`.
3. Apply the filter in `ShadowFinderVisualization` without re-running the grid computation.

## Azimuth Math

```
// 1. Shadow pixel vector (objectBottom → shadowTip)
dx = shadowTip.x − objectBottom.x
dy = shadowTip.y − objectBottom.y

// 2. Shadow angle from image "up" (clockwise positive)
shadowImageAngle = atan2(dx, −dy) × 180/π

// 3. Absolute shadow bearing (True North)
shadowBearing = (cameraBearing + shadowImageAngle + 360) % 360

// 4. Sun is opposite the shadow
sunBearing = (shadowBearing + 180) % 360

// 5. SunCalc azimuth → compass bearing (per grid point)
// SunCalc: 0 = South, positive = West, negative = East (radians)
sunCalcBearing = (azimuthRad × 180/π + 180 + 360) % 360

// 6. Filter: keep points within ±10°
keep if angularDiff(sunCalcBearing, sunBearing) < 10
```

Angular diff handles the 0°/360° wraparound.

## Key Design Decisions

- **Post-filter, not re-generate.** Grid points always store their sun azimuth. Toggling the constraint re-renders the visualization instantly — no 200k-point re-computation.
- **Azimuth computed eagerly.** Calculated as soon as all 3 points are marked AND compass bearing is available. Shown in the panel before the user clicks Analyze.
- **Magnetic bearing → disabled.** `compassRef = "M"`: toggle shown, disabled, with explanation. `compassRef = "T"` or null (True North assumed): toggle available.
- **Default on.** Toggle defaults to enabled when the constraint becomes available.
- **Fixed ±10° tolerance.** Absorbs camera tilt, lens distortion, and marking imprecision. Not user-adjustable.

## New Interfaces

```ts
// shadowfinder.ts
interface ShadowFinderPoint {
  lat: number;
  lng: number;
  likelihood: number;
  sunAzimuthDeg: number;  // NEW — always populated
}

interface AzimuthConstraint {
  sunBearingDeg: number;  // computed from shadow direction + camera bearing
  toleranceDeg: number;   // fixed at 10
  enabled: boolean;
}
```

## Files Changed

### Modified: `src/lib/shadowfinder.ts`

- Add `sunAzimuthDeg: number` to `ShadowFinderPoint` — populated from `SunCalc.getPosition().azimuth` converted to compass bearing. Zero extra compute cost (azimuth already returned by SunCalc, currently discarded).
- Export `AzimuthConstraint` interface.
- Export `applyAzimuthConstraint(points: ShadowFinderPoint[], constraint: AzimuthConstraint): ShadowFinderPoint[]` — pure filter function, handles wraparound.

### Modified: `src/components/InteractiveImage.tsx`

CSS-only loupe magnifier:
- Track cursor position in state via `onMouseMove`.
- Render a `div` with `border-radius: 50%`, `overflow: hidden`, positioned 20px up-right of cursor (clamped to image bounds).
- Inside: same `<img>` at `transform: scale(3)` with `transform-origin` set to cursor's relative position — makes zoom track correctly without canvas or a second image load.
- Cyan crosshairs: two 1px absolutely-positioned lines through centre.
- Visible when: image loaded AND `points.length < 3` AND cursor is over image.
- Hidden when: all 3 points placed, or cursor leaves image.

### Modified: `src/components/AnalysisPanel.tsx`

New prop: `onAzimuthConstraint(constraint: AzimuthConstraint | null): void`

New azimuth section rendered below EXIF badge, above date/time inputs:

| State | Toggle | Body |
|---|---|---|
| No `compassBearing` in EXIF | Disabled | "No compass bearing in photo EXIF" |
| `compassRef = "M"` | Disabled | "Magnetic bearing — azimuth constraint unavailable" |
| Bearing OK, < 3 points marked | Disabled | "Mark all 3 points to enable" |
| Bearing OK, 3 points marked | Enabled | Camera bearing + computed sun bearing |

`sunBearingDeg` computed via `useMemo` watching `points` and `photoMetadata.compassBearing`. Toggle fires `onAzimuthConstraint` immediately on change so visualization updates without re-analysis.

### Modified: `src/pages/Index.tsx`

- Add state: `firstAzimuthConstraint: AzimuthConstraint | null`, `secondAzimuthConstraint: AzimuthConstraint | null`.
- Wire `onAzimuthConstraint` callback on `AnalysisPanel` → store in state.
- Clear constraint when image is replaced or analysis is reset.
- Pass current constraint to `ShadowFinderVisualization`.

### Modified: `src/components/ShadowFinderVisualization.tsx`

New prop: `azimuthConstraint?: AzimuthConstraint | null`

- When constraint is enabled: call `applyAzimuthConstraint(points, constraint)` before passing to D3. Add `🧭 Azimuth-constrained` badge.
- When constraint is null or disabled: render exactly as today.
- Intersection mode: each photo's constraint applied to its own result set independently.

## Edge Cases

- **Filter removes all points** — fall back to unfiltered result, show warning badge "Azimuth constraint produced no matches — showing shadow band only".
- **User replaces image** — constraint cleared, toggle resets.
- **User removes a point (back to < 3)** — toggle disables, `onAzimuthConstraint(null)` fires, visualization reverts to full band.
- **analysisMode switches** — `AnalysisPanel` remounts with new `photoMetadata`, constraint recalculated from scratch.

## Build Sequence

1. `shadowfinder.ts` — add `sunAzimuthDeg`, `AzimuthConstraint` interface, `applyAzimuthConstraint()`
2. `InteractiveImage.tsx` — loupe magnifier
3. `AnalysisPanel.tsx` — azimuth section, toggle, sun bearing computation, `onAzimuthConstraint` callback
4. `Index.tsx` — wire `onAzimuthConstraint` → state, pass to visualization
5. `ShadowFinderVisualization.tsx` — apply filter, add badge, fallback warning

## Out of Scope

- Magnetic declination correction (requires knowing location — circular dependency)
- Azimuth ring overlay on the world map (deferred)
- User-adjustable tolerance
- Camera tilt correction

## Follow-on

With shadow length + azimuth both constraining the result, the candidate region is small enough that overlaying on a real map tile (Leaflet/Mapbox) becomes meaningful. Magnetic declination correction is also unlocked: once azimuth narrows the location to a region, we can look up declination for that centroid and offer a corrected re-run.
