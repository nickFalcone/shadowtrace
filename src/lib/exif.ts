import exifr from 'exifr';

export interface PhotoMetadata {
  localTime: Date | null;
  utcOffset: string | null;
  utcTime: Date | null;
  hasGPSTime: boolean;
  compassBearing: number | null;
  compassRef: 'T' | 'M' | null;
  gpsCoords: { lat: number; lng: number } | null;
  focalLength35mm: number | null;
}

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
      localTime: null,
      utcOffset: null,
      utcTime: null,
      hasGPSTime: false,
      compassBearing: null,
      compassRef: null,
      gpsCoords: null,
      focalLength35mm: null,
    };

    const isValid = (d: unknown): d is Date =>
      d instanceof Date && !isNaN(d.getTime());

    // Parse raw EXIF date string "YYYY:MM:DD HH:MM:SS" using Date.UTC so the
    // resulting Date's UTC value equals the local wall-clock components.
    // toISOString() then returns the local time, and all offset math is correct.
    const rawDT = exifRaw?.DateTimeOriginal;
    if (typeof rawDT === 'string') {
      const [datePart, timePart] = rawDT.split(' ');
      if (datePart && timePart) {
        const [year, month, day] = datePart.split(':').map(Number);
        const [hours, minutes, seconds] = timePart.split(':').map(Number);
        const normalized = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
        if (isValid(normalized)) {
          result.localTime = normalized;
        }
      }
    }

    if (exif && typeof exif.OffsetTimeOriginal === 'string') {
      result.utcOffset = exif.OffsetTimeOriginal;
    }

    // GPS UTC time is the most accurate source.
    // GPSTimeStamp may come back as "HH:MM:SS" string or [h, m, s] number array.
    if (exif?.GPSDateStamp && exif?.GPSTimeStamp) {
      const [year, month, day] = (exif.GPSDateStamp as string).split(':').map(Number);
      let hours: number, minutes: number, seconds: number;
      if (typeof exif.GPSTimeStamp === 'string') {
        [hours, minutes, seconds] = (exif.GPSTimeStamp as string).split(':').map(Number);
      } else {
        const ts = exif.GPSTimeStamp as number[];
        hours = Math.floor(ts[0]);
        minutes = Math.floor(ts[1]);
        seconds = Math.floor(ts[2]);
      }
      const gpsTime = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
      if (isValid(gpsTime)) {
        result.utcTime = gpsTime;
        result.hasGPSTime = true;
      }
    } else if (result.localTime && result.utcOffset) {
      // localTime.getTime() is local wall-clock expressed as UTC ms (no TZ baked in),
      // so subtracting the EXIF offset gives the true UTC time.
      const match = result.utcOffset.match(/^([+-])(\d{2}):(\d{2})$/);
      if (match) {
        const sign = match[1] === '+' ? 1 : -1;
        const offsetMs = sign * (parseInt(match[2]) * 60 + parseInt(match[3])) * 60000;
        const computed = new Date(result.localTime.getTime() - offsetMs);
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

    if (exif?.FocalLengthIn35mmFormat != null &&
        isFinite(Number(exif.FocalLengthIn35mmFormat)) &&
        Number(exif.FocalLengthIn35mmFormat) > 0) {
      result.focalLength35mm = Number(exif.FocalLengthIn35mmFormat);
    }

    if (gps?.latitude != null && gps?.longitude != null &&
        isFinite(gps.latitude) && isFinite(gps.longitude)) {
      result.gpsCoords = { lat: gps.latitude, lng: gps.longitude };
    }

    if (!result.localTime && !result.utcTime && !result.gpsCoords) return null;

    const source = result.hasGPSTime ? 'gps' : result.utcOffset ? 'offset' : 'local-only';
    console.log('[exif]', {
      source,
      localTime: result.localTime?.toISOString() ?? null,
      utcOffset: result.utcOffset,
      utcTime: result.utcTime?.toISOString() ?? null,
      compassBearing: result.compassBearing,
      compassRef: result.compassRef,
      gpsCoords: result.gpsCoords,
      focalLength35mm: result.focalLength35mm,
    });

    return result;
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

/** Apply a UTC offset (minutes) to a local Date to get UTC Date */
export function applyUtcOffset(localTime: Date, offsetMinutes: number): Date {
  return new Date(localTime.getTime() - offsetMinutes * 60_000);
}

/** Format a Date as "YYYY-MM-DD" for date input values */
export function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Format a Date as "HH:MM" for time input values */
export function formatTimeInput(date: Date): string {
  return date.toISOString().slice(11, 16);
}

/**
 * Computes horizontal FOV in degrees from a 35mm-equivalent focal length.
 * Falls back to 65° (≈28mm) when focal length is unavailable.
 * Assumes landscape orientation (36mm wide); portrait shots will appear ~19° wider than actual.
 */
export function computeFovDeg(focalLength35mm: number | null): number {
  if (focalLength35mm != null && focalLength35mm > 0) {
    return 2 * Math.atan(36 / (2 * focalLength35mm)) * (180 / Math.PI);
  }
  return 65;
}
