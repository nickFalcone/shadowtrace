import exifr from 'exifr';
import geomagnetism from 'geomagnetism';

/** Long edge of a 35mm full-frame sensor (mm) — used as the FOV horizontal dimension. */
const SENSOR_LONG_DIM_MM = 36;
/** Short edge of a 35mm full-frame sensor (mm) — used for portrait-orientation FOV. */
const SENSOR_SHORT_DIM_MM = 24;
/** Default horizontal FOV (degrees) when no focal length is recorded — roughly a 28mm lens. */
const DEFAULT_FOV_DEG = 65;

export interface PhotoMetadata {
  /**
   * Photo capture wall-clock time as an ISO 8601 string WITHOUT a timezone
   * suffix, e.g. `"2024-03-15T14:30:00"`. The trailing `Z` is intentionally
   * omitted because EXIF `DateTimeOriginal` does not specify a timezone. Use
   * `applyUtcOffset` to convert to a true UTC `Date` once an offset is known.
   *
   * (Storing this as a `Date` would be a footgun: `getHours()` returns the
   * browser-local interpretation of the bytes, not the photo's wall clock.)
   */
  localWallClock: string | null;
  utcOffset: string | null;
  utcTime: Date | null;
  hasGPSTime: boolean;
  /**
   * Camera bearing in degrees [0, 360). When `magneticDeclination` is non-null
   * the bearing has been corrected from magnetic to true north and `compassRef`
   * will report `'T'`. When `compassRef === 'M'` (no GPS to derive declination
   * from), the bearing is the raw magnetic value and downstream consumers
   * should ignore it.
   */
  compassBearing: number | null;
  compassRef: 'T' | 'M' | null;
  gpsCoords: { lat: number; lng: number } | null;
  focalLength35mm: number | null;
  /**
   * WMM2025 declination at the photo's GPS location, in degrees east-positive.
   * Set only when a magnetic bearing has been corrected to true north;
   * otherwise null.
   */
  magneticDeclination: number | null;
}

const UTC_OFFSET_RE = /^([+-])(\d{2}):?(\d{2})?$/;

export async function extractPhotoMetadata(file: File): Promise<PhotoMetadata | null> {
  try {
    // Two concurrent parses: main for GPS/compass (revived values), second for the raw
    // DateTimeOriginal string. exifr's parsed Date bakes in the browser's local TZ, making
    // getHours() return browser-local hours rather than EXIF local hours. Parsing the raw
    // "YYYY:MM:DD HH:MM:SS" string ourselves avoids all browser-timezone ambiguity.
    const [exif, exifRaw, gps] = await Promise.all([
      exifr.parse(file, {
        pick: [
          'OffsetTimeOriginal',
          'GPSDateStamp',
          'GPSTimeStamp',
          'GPSImgDirection',
          'GPSImgDirectionRef',
          'FocalLengthIn35mmFormat',
        ],
      }),
      exifr.parse(file, {
        pick: ['DateTimeOriginal'],
        reviveValues: false,
      }),
      exifr.gps(file).catch(() => null),
    ]);

    if (!exif && !exifRaw && !gps) return null;

    const result: PhotoMetadata = {
      localWallClock: null,
      utcOffset: null,
      utcTime: null,
      hasGPSTime: false,
      compassBearing: null,
      compassRef: null,
      gpsCoords: null,
      focalLength35mm: null,
      magneticDeclination: null,
    };

    const isValid = (d: unknown): d is Date =>
      d instanceof Date && !isNaN(d.getTime());

    // EXIF DateTimeOriginal is "YYYY:MM:DD HH:MM:SS" with no timezone. Normalize
    // it to ISO 8601 sans timezone — the colon-separated date becomes dash-separated.
    const rawDT = exifRaw?.DateTimeOriginal;
    if (typeof rawDT === 'string') {
      const wallClock = normalizeExifDateString(rawDT);
      if (wallClock) result.localWallClock = wallClock;
    }

    if (exif && typeof exif.OffsetTimeOriginal === 'string') {
      result.utcOffset = exif.OffsetTimeOriginal;
    }

    // GPS UTC time is the most accurate source.
    // GPSTimeStamp may come back as "HH:MM:SS" string or [h, m, s] number array
    // (the latter may contain fractional seconds — preserve them as milliseconds).
    if (exif?.GPSDateStamp && exif?.GPSTimeStamp) {
      const [year, month, day] = (exif.GPSDateStamp as string).split(':').map(Number);
      let hours: number, minutes: number, seconds: number, ms: number;
      if (typeof exif.GPSTimeStamp === 'string') {
        [hours, minutes, seconds] = (exif.GPSTimeStamp as string).split(':').map(Number);
        ms = 0;
      } else {
        const ts = exif.GPSTimeStamp as number[];
        hours = Math.floor(ts[0]);
        minutes = Math.floor(ts[1]);
        seconds = Math.floor(ts[2]);
        ms = Math.round((ts[2] - seconds) * 1000);
      }
      const gpsTime = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, ms));
      if (isValid(gpsTime)) {
        result.utcTime = gpsTime;
        result.hasGPSTime = true;
      }
    } else if (result.localWallClock && result.utcOffset) {
      const offsetMinutes = parseUtcOffset(result.utcOffset);
      if (offsetMinutes !== null) {
        const computed = applyUtcOffset(result.localWallClock, offsetMinutes);
        if (isValid(computed)) {
          result.utcTime = computed;
        }
      }
    }

    if (exif?.GPSImgDirection != null) {
      result.compassBearing = Number(exif.GPSImgDirection);
    }

    if (exif?.GPSImgDirectionRef === 'T' || exif?.GPSImgDirectionRef === 'M') {
      result.compassRef = exif.GPSImgDirectionRef as 'T' | 'M';
    }

    const focal = Number(exif?.FocalLengthIn35mmFormat);
    if (Number.isFinite(focal) && focal > 0) {
      result.focalLength35mm = focal;
    }

    if (gps?.latitude != null && gps?.longitude != null &&
        Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      result.gpsCoords = { lat: gps.latitude, lng: gps.longitude };
    }

    // Correct a magnetic bearing to true north using the WMM at the photo's
    // GPS location. Only applied when we have both the bearing and the location;
    // a magnetic-only bearing without GPS is left untouched (downstream code
    // already ignores it).
    if (
      result.compassRef === 'M' &&
      result.compassBearing != null &&
      result.gpsCoords
    ) {
      const referenceDate =
        result.utcTime ??
        (result.localWallClock ? new Date(result.localWallClock + 'Z') : new Date());
      const corrected = correctMagneticBearing(
        result.compassBearing,
        result.gpsCoords,
        referenceDate,
      );
      // Defensive: out-of-range dates with allowOutOfBoundsModel=true should
      // still yield a finite declination; if not, leave the bearing as magnetic.
      if (corrected) {
        result.compassBearing = corrected.trueBearing;
        result.compassRef = 'T';
        result.magneticDeclination = corrected.declination;
      }
    }

    if (!result.localWallClock && !result.utcTime && !result.gpsCoords) return null;

    if (import.meta.env.DEV) {
      const source = result.hasGPSTime ? 'gps' : result.utcOffset ? 'offset' : 'local-only';
      console.log('[exif]', {
        source,
        localWallClock: result.localWallClock,
        utcOffset: result.utcOffset,
        utcTime: result.utcTime?.toISOString() ?? null,
        compassBearing: result.compassBearing,
        compassRef: result.compassRef,
        magneticDeclination: result.magneticDeclination,
        gpsCoords: result.gpsCoords,
        focalLength35mm: result.focalLength35mm,
      });
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Normalize EXIF `DateTimeOriginal` ("YYYY:MM:DD HH:MM:SS") into an ISO 8601
 * wall-clock string without a timezone suffix. Returns null on malformed input.
 */
function normalizeExifDateString(raw: string): string | null {
  const [datePart, timePart] = raw.split(' ');
  if (!datePart || !timePart) return null;
  const [year, month, day] = datePart.split(':');
  const [hours, minutes, seconds] = timePart.split(':');
  if (!year || !month || !day || !hours || !minutes || !seconds) return null;
  // Validate by round-tripping through Date.UTC — catches "0000:00:00 00:00:00"
  // and other malformed values that exifr sometimes hands back.
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds));
  if (isNaN(ms)) return null;
  const pad = (n: string) => n.padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Parse an EXIF `OffsetTimeOriginal` string ("+HH:MM", "+HHMM", or "+HH") to
 * a signed minute offset. Returns null on malformed input.
 */
export function parseUtcOffset(offset: string): number | null {
  const m = UTC_OFFSET_RE.exec(offset);
  if (!m) return null;
  const hours = parseInt(m[2], 10);
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  const magnitude = hours * 60 + minutes;
  // Normalize -0 to +0 so "-00:00" and "+00:00" are indistinguishable downstream.
  if (magnitude === 0) return 0;
  return m[1] === '+' ? magnitude : -magnitude;
}

/**
 * Apply the WMM2025 declination at the given GPS location to convert a
 * magnetic compass bearing to true north. Returns null if the library can't
 * produce a finite declination (e.g. NaN inputs or model failure).
 *
 *   trueBearing = magneticBearing + eastward_declination
 *
 * Exported for testing; callers usually let `extractPhotoMetadata` apply this
 * automatically when EXIF reports a magnetic bearing alongside GPS coords.
 */
export function correctMagneticBearing(
  magneticBearingDeg: number,
  gpsCoords: { lat: number; lng: number },
  forDate: Date,
): { trueBearing: number; declination: number } | null {
  if (
    !Number.isFinite(magneticBearingDeg) ||
    !Number.isFinite(gpsCoords.lat) ||
    !Number.isFinite(gpsCoords.lng)
  ) {
    return null;
  }
  try {
    const model = geomagnetism.model(forDate, { allowOutOfBoundsModel: true });
    const point = model.point([gpsCoords.lat, gpsCoords.lng]);
    const declination = point.decl;
    if (!Number.isFinite(declination)) return null;
    const trueBearing = ((magneticBearingDeg + declination) % 360 + 360) % 360;
    return { trueBearing, declination };
  } catch {
    return null;
  }
}

/** Generate UTC offset options from −12:00 to +14:00 in 30-minute steps */
export function getUtcOffsetOptions(): { label: string; minutes: number }[] {
  const options: { label: string; minutes: number }[] = [];
  for (let m = -720; m <= 840; m += 30) {
    const sign = m >= 0 ? '+' : '-';
    const abs = Math.abs(m);
    const h = String(Math.floor(abs / 60)).padStart(2, '0');
    const min = String(abs % 60).padStart(2, '0');
    options.push({ label: `UTC${sign}${h}:${min}`, minutes: m });
  }
  return options;
}

/**
 * Convert a wall-clock ISO string (no timezone) to a true UTC `Date` by
 * subtracting the local offset. Appending `Z` parses the wall-clock as if it
 * were UTC, so we then subtract the offset to recover the real UTC instant.
 */
export function applyUtcOffset(localWallClock: string, offsetMinutes: number): Date {
  const asUtcInstant = new Date(localWallClock + 'Z');
  return new Date(asUtcInstant.getTime() - offsetMinutes * 60000);
}

/** Format a UTC `Date` or wall-clock string as "YYYY-MM-DD" for date input values. */
export function formatDateInput(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** Format a UTC `Date` or wall-clock string as "HH:MM" for time input values. */
export function formatTimeInput(value: Date | string): string {
  if (typeof value === 'string') return value.slice(11, 16);
  return value.toISOString().slice(11, 16);
}

/**
 * Computes horizontal FOV in degrees from a 35mm-equivalent focal length.
 * Falls back to DEFAULT_FOV_DEG (≈28mm) when focal length is unavailable.
 * Pass `isPortrait` to use the shorter sensor dimension when the photo was
 * taken in portrait orientation.
 */
export function computeFovDeg(focalLength35mm: number | null, isPortrait = false): number {
  if (focalLength35mm != null && focalLength35mm > 0) {
    const sensorDim = isPortrait ? SENSOR_SHORT_DIM_MM : SENSOR_LONG_DIM_MM;
    return 2 * Math.atan(sensorDim / (2 * focalLength35mm)) * (180 / Math.PI);
  }
  return DEFAULT_FOV_DEG;
}
