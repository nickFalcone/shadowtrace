# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # dev server at http://localhost:8080/shadowtrace/
npm run build      # production build
npm run lint       # ESLint
npm run test       # vitest (run once)
npm run test:watch # vitest (watch mode)
npx tsc --noEmit   # type-check
```

Type-check and run tests after every change. Test files are colocated (`*.test.ts` next to the source file).

## Architecture

Single-page app. One route (`/`), one page component (`src/pages/Index.tsx`).

**Data flow:**
1. User uploads a photo → `extractPhotoMetadata` (`src/lib/exif.ts`) runs two concurrent `exifr.parse` calls plus `exifr.gps()` to extract timestamp, compass bearing, focal length, and GPS coords into `PhotoMetadata`.
2. User marks 3 points on the image (object base, object top, shadow tip) via `InteractiveImage`.
3. "Estimate Location" → `generateShadowFinderGrid` + `analyzeShadowMeasurements` (`src/lib/shadowfinder.ts`) sweep a 0.5° global grid using SunCalc, scoring each point by how well its theoretical shadow ratio matches the measured one.
4. Results pass as props to `ShadowFinderVisualization`, which renders a Leaflet heatmap plus optional GPS marker and FOV cone.

**Dual-photo mode:** `Index.tsx` maintains mirrored state for first/second photos (`firstPhotoMeta`/`secondPhotoMeta`, etc.). When both analyses exist, `ShadowFinderVisualization` intersects their high-probability grids and renders a single combined heatmap.

**Azimuth constraint** (`AzimuthConstraint` from `shadowfinder.ts`) is a post-analysis filter applied in `ShadowFinderVisualization` via `applyAzimuthConstraint` — no re-computation on toggle.

## Key files

| File | Responsibility |
|------|---------------|
| `src/lib/shadowfinder.ts` | Bellingcat grid algorithm, azimuth constraint, location estimation |
| `src/lib/exif.ts` | EXIF extraction (`PhotoMetadata`), `computeFovDeg` utility |
| `src/pages/Index.tsx` | All app state, orchestrates photo/analysis/mode flow |
| `src/components/AnalysisPanel.tsx` | Timestamp editing, azimuth toggle, GPS display |
| `src/components/ShadowFinderVisualization.tsx` | Leaflet map, heatmap, GPS marker, FOV cone |
| `src/components/InteractiveImage.tsx` | Point marking with loupe magnifier |
| `src/types/leaflet-heat.d.ts` | Type shim for `leaflet.heat` (no upstream types) |

## Leaflet pattern

All map layers use the imperative `useMap()` + `useEffect` pattern — **not** declarative react-leaflet components. See `HeatmapLayer`, `GpsMarkerLayer`, and `GpsConeLayer` in `ShadowFinderVisualization.tsx` for the established pattern:

```tsx
function MyLayer({ ... }) {
  const map = useMap();
  useEffect(() => {
    const layer = L.something(...).addTo(map);
    return () => { map.removeLayer(layer); };
  }, [/* deps */]);
  return null;
}
```

Import Leaflet as `import * as L from 'leaflet'` — the default import (`import L from 'leaflet'`) breaks with this project's CommonJS interop (TS1259).

Popup content must be built with DOM methods (`createElement`, `textContent`) — never string interpolation — to avoid XSS.

## React conventions

These are enforced at code review (see `CONVENTIONS_REACT.md` for full examples):

- **`useEffect` requires a comment** explaining which external system is being synced, what cleanup does, and why the dep array is what it is. No exceptions.
- **No render functions** (`const renderX = () => <JSX />`). Extract to a named component instead.
- **No numeric separators** — write `30000`, not `30_000`.
- **Early returns** for conditional rendering, not nested ternaries.
- **No premature `useMemo`/`useCallback`** — only when a measured perf problem exists.

## Vite / path alias

`@/` resolves to `src/`. Base path is `/shadowtrace/` (configured in `vite.config.ts`).
