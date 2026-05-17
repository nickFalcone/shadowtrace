# EXIF Extraction Feature Design

**Date:** 2026-05-17
**Branch:** feature/exif-compass-azimuth
**Status:** Approved

## Problem

Users must manually type the photo date and time, then convert to UTC by hand. This is error-prone — the reported issue was a user subtracting their UTC offset instead of adding it, which produced a ~155° longitude error in the result. This is the most common failure mode for the tool.

## Goal

Automatically extract timestamp and compass bearing from uploaded photo EXIF metadata, pre-fill the analysis form, and guide the user through timezone confirmation when the UTC offset cannot be determined automatically.

## Scope

This spec covers EXIF extraction and timestamp pre-fill only. The compass bearing is extracted and stored in state for the follow-on azimuth constraint feature but is not wired into the analysis in this iteration.

## New Dependency

`exifr` — browser-compatible EXIF parsing library. Works directly with `File` objects. No server required.

## Data Extracted

| EXIF Field | Purpose |
|---|---|
| `DateTimeOriginal` | Local camera time when photo was taken |
| `OffsetTimeOriginal` | UTC offset string (e.g. `"-05:00"`), present on EXIF 2.31+ devices |
| `GPSDateStamp` + `GPSTimeStamp` | GPS-synced UTC time — most accurate source |
| `GPSImgDirection` | Compass bearing 0–360° — stored for future azimuth feature |
| `GPSImgDirectionRef` | `"T"` (true north) or `"M"` (magnetic) — stored alongside bearing |

## UTC Time Resolution Priority

1. **GPS UTC time** — use directly, no user confirmation needed
2. **DateTimeOriginal + OffsetTimeOriginal** — compute UTC automatically, show "converted" note
3. **DateTimeOriginal only** — pre-fill local time, show timezone dropdown for user to select offset

## Files Changed

### New: `src/lib/exif.ts`

Exports:

```ts
interface PhotoMetadata {
  localTime: Date | null;
  utcOffset: string | null;       // e.g. "-05:00"
  utcTime: Date | null;           // resolved UTC time if determinable
  hasGPSTime: boolean;
  compassBearing: number | null;  // degrees, 0–360
  compassRef: 'T' | 'M' | null;
}

async function extractPhotoMetadata(file: File): Promise<PhotoMetadata | null>
```

Returns `null` if EXIF is absent or unreadable (graceful fallback to current behavior).

### Modified: `src/components/AnalysisPanel.tsx`

- Accepts new optional prop: `photoMetadata: PhotoMetadata | null`
- On mount / when `photoMetadata` changes: pre-fill `selectedDate` and `selectedTime` from resolved UTC time
- Renders one of three states below the existing "Reference Points" section:

| State | UI |
|---|---|
| GPS time or offset resolved | Pre-filled inputs + small "Detected from photo" badge, no dropdown |
| Local time only | Pre-filled inputs + UTC offset picker (−12 to +14, 30-min increments) + warning note explaining why |
| No EXIF | Current UI unchanged |

- Emits compass bearing via a new optional `onMetadataReady(meta: PhotoMetadata)` callback so `Index.tsx` can store it in state.

### Modified: `Index.tsx`

- After `handleImageUpload`: call `extractPhotoMetadata(file)`, store result as `firstPhotoMeta` / `secondPhotoMeta` in state
- Pass `photoMetadata` prop to `AnalysisPanel`
- Store `compassBearing` from metadata in state (unused in analysis until azimuth feature)

## Behavior When EXIF Is Absent

If `extractPhotoMetadata` returns `null`, `AnalysisPanel` renders exactly as today — no visible change for the user.

## Out of Scope

- GPS latitude/longitude (not extracted — would undermine the OSINT exercise)
- Azimuth constraint logic (next feature)
- EXIF editing or writing

## Follow-on

The `compassBearing` stored in state in this feature becomes the primary input for the azimuth constraint in the next feature iteration.
