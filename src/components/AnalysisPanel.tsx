import React, { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Calendar, MapPin, Calculator, Clock, Satellite, Info, Compass, HelpCircle } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { ClickPoint } from './InteractiveImage';
import {
  PhotoMetadata,
  getUtcOffsetOptions,
  applyUtcOffset,
  formatDateInput,
  formatTimeInput,
} from '@/lib/exif';
import { AzimuthConstraint, DEFAULT_AZIMUTH_TOLERANCE_DEG } from '@/lib/shadowfinder';

interface AnalysisPanelProps {
  points: ClickPoint[];
  onAnalyze: (date: Date) => void;
  isAnalyzing: boolean;
  measurements?: {
    objectHeight: number;
    shadowLength: number;
  } | null;
  analysisMode?: 'first' | 'second';
  photoMetadata?: PhotoMetadata | null;
  onAzimuthConstraint: (constraint: AzimuthConstraint | null) => void;
}

const UTC_OFFSET_OPTIONS = getUtcOffsetOptions();

// Default offset picker to the browser's current UTC offset
function browserOffsetMinutes(): number {
  const raw = -new Date().getTimezoneOffset(); // getTimezoneOffset returns inverted sign
  // Round to nearest 30-min step
  return Math.round(raw / 30) * 30;
}

function computeSunBearing(points: ClickPoint[], photoMetadata: PhotoMetadata | null | undefined): number | null {
  const bearing = photoMetadata?.compassBearing;
  if (bearing == null || photoMetadata?.compassRef === 'M' || points.length < 3) return null;
  const objectBottom = points.find(p => p.type === 'object-bottom');
  const shadowTip = points.find(p => p.type === 'shadow-tip');
  if (!objectBottom || !shadowTip) return null;
  const dx = shadowTip.x - objectBottom.x;
  const dy = shadowTip.y - objectBottom.y;
  const shadowImageAngle = Math.atan2(dx, -dy) * 180 / Math.PI;
  const shadowBearing = ((bearing + shadowImageAngle) % 360 + 360) % 360;
  return (shadowBearing + 180) % 360;
}

// Format GPS coordinates as decimal-degree string (e.g., "40.7128°N, 74.0060°W")
function formatCoords(lat: number, lng: number): string {
  const latStr = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
  const lngStr = `${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
  return `${latStr}, ${lngStr}`;
}

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
  points,
  onAnalyze,
  isAnalyzing,
  measurements,
  analysisMode = 'first',
  photoMetadata,
  onAzimuthConstraint,
}) => {
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedTime, setSelectedTime] = useState('12:00');
  const [manualOffsetMinutes, setManualOffsetMinutes] = useState<number>(browserOffsetMinutes);
  const [azimuthEnabled, setAzimuthEnabled] = useState(false);

  // Pre-fill date/time inputs from EXIF metadata when a new photo is uploaded.
  // MUST use useEffect — calling setters during render would cause infinite re-renders.
  // Deps: [photoMetadata] — re-fill whenever a new photo's metadata arrives.
  useEffect(() => {
    if (!photoMetadata) return;

    if (photoMetadata.utcTime) {
      setSelectedDate(formatDateInput(photoMetadata.utcTime));
      setSelectedTime(formatTimeInput(photoMetadata.utcTime));
    } else if (photoMetadata.localWallClock) {
      setSelectedDate(formatDateInput(photoMetadata.localWallClock));
      setSelectedTime(formatTimeInput(photoMetadata.localWallClock));
    }
  }, [photoMetadata]);

  // Recompute displayed UTC time when the user adjusts the offset picker.
  // MUST use useEffect — calling setters during render would cause infinite re-renders.
  // Deps: [manualOffsetMinutes, photoMetadata] — recalculate when either changes.
  useEffect(() => {
    if (!photoMetadata?.localWallClock || photoMetadata.utcTime) return;
    const utc = applyUtcOffset(photoMetadata.localWallClock, manualOffsetMinutes);
    setSelectedDate(formatDateInput(utc));
    setSelectedTime(formatTimeInput(utc));
  }, [manualOffsetMinutes, photoMetadata]);

  const handleCopyCoords = () => {
    if (!photoMetadata?.gpsCoords || !navigator.clipboard) return;
    const { lat, lng } = photoMetadata.gpsCoords;
    navigator.clipboard.writeText(`${lat},${lng}`).catch(() => {});
  };

  // sunBearingDeg is a primitive (number | null) — computed directly during render, no useMemo needed.
  const sunBearingDeg = computeSunBearing(points, photoMetadata);

  // Auto-enable the azimuth toggle when a sun bearing first becomes computable.
  // MUST use useEffect — calling setAzimuthEnabled during render would cause infinite re-renders.
  // Deps: [sunBearingDeg] — fire only when bearing availability changes.
  useEffect(() => {
    if (sunBearingDeg !== null) setAzimuthEnabled(true);
  }, [sunBearingDeg]);

  // Emit the current azimuth constraint to the parent whenever bearing or toggle changes.
  // MUST use useEffect — calling onAzimuthConstraint during render re-renders the parent,
  // which re-renders this component, causing an infinite loop.
  // Deps: [sunBearingDeg, azimuthEnabled, onAzimuthConstraint] — recalculate on any change.
  useEffect(() => {
    if (sunBearingDeg !== null && azimuthEnabled) {
      onAzimuthConstraint({ sunBearingDeg, toleranceDeg: DEFAULT_AZIMUTH_TOLERANCE_DEG, enabled: true });
    } else {
      onAzimuthConstraint(null);
    }
  }, [sunBearingDeg, azimuthEnabled, onAzimuthConstraint]);

  const hasBearing = photoMetadata?.compassBearing != null;
  const isMagnetic = photoMetadata?.compassRef === 'M';
  const hasAllPoints = points.length >= 3;
  const canToggleAzimuth = hasBearing && !isMagnetic && hasAllPoints && sunBearingDeg !== null;

  const azimuthStatusNote =
    !hasBearing ? 'No compass bearing in photo EXIF'
    : isMagnetic ? 'Magnetic bearing — azimuth constraint unavailable'
    : !hasAllPoints ? 'Mark all 3 points to enable'
    : null;

  const handleAnalyze = () => {
    if (selectedDate) {
      onAnalyze(new Date(`${selectedDate}T${selectedTime}Z`));
    }
  };

  const isReady = points.length === 3 && selectedDate;

  // Determine which EXIF badge state to show
  const exifState: 'gps' | 'offset' | 'local' | 'none' =
    !photoMetadata ? 'none'
    : photoMetadata.hasGPSTime ? 'gps'
    : photoMetadata.utcOffset ? 'offset'
    : photoMetadata.localWallClock ? 'local'
    : 'none';

  return (
    <Card className="cyber-border">
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${analysisMode === 'first' ? 'bg-cyber-primary/10' : 'bg-cyber-secondary/10'}`}>
            <Calculator className={`w-5 h-5 ${analysisMode === 'first' ? 'text-cyber-primary' : 'text-cyber-secondary'}`} />
          </div>
          <div>
            <h3 className="text-lg font-semibold">
              {analysisMode === 'first' ? 'First Photo' : 'Second Photo'} Analysis
            </h3>
            <p className="text-sm text-muted-foreground">
              {analysisMode === 'first'
                ? 'Geometric location estimation via shadow triangulation'
                : 'Second photo analysis for intersection precision'
              }
            </p>
          </div>
        </div>

        {/* Reference point measurements */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">Reference Points</Label>
          {measurements ? (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-2 rounded bg-muted/50 border border-border/50">
                <div className="text-muted-foreground mb-1">Object Height</div>
                <div className="font-mono text-cyber-primary">{measurements.objectHeight.toFixed(0)}px</div>
              </div>
              <div className="p-2 rounded bg-muted/50 border border-border/50">
                <div className="text-muted-foreground mb-1">Shadow Length</div>
                <div className="font-mono text-cyber-secondary">{measurements.shadowLength.toFixed(0)}px</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Mark all three points on the image to see measurements
            </div>
          )}
        </div>

        {/* Date and time inputs */}
        <div className="space-y-4">
          {/* Azimuth Constraint */}
          {photoMetadata && (
            <div className="space-y-2 p-3 rounded-md bg-muted/30 border border-border/50">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <Compass className="w-4 h-4" />
                  Azimuth Constraint
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      Uses the camera's compass bearing combined with the shadow direction to compute the sun's azimuth. Filters the shadow band to locations where the sun's position matches — narrowing results from a global band to a candidate region.
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <button
                  role="switch"
                  aria-checked={azimuthEnabled && canToggleAzimuth}
                  disabled={!canToggleAzimuth}
                  onClick={() => canToggleAzimuth && setAzimuthEnabled(e => !e)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                    azimuthEnabled && canToggleAzimuth
                      ? 'bg-cyber-primary'
                      : 'bg-muted-foreground/30'
                  } ${!canToggleAzimuth ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                >
                  <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                    azimuthEnabled && canToggleAzimuth ? 'translate-x-5' : 'translate-x-1'
                  }`} />
                </button>
              </div>

              {azimuthStatusNote && (
                <p className="text-xs text-muted-foreground">{azimuthStatusNote}</p>
              )}

              {sunBearingDeg !== null && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 rounded bg-muted/50 border border-border/50">
                    <div className="text-muted-foreground mb-1">Camera bearing</div>
                    <div className="font-mono text-amber-400">
                      {photoMetadata.compassBearing!.toFixed(1)}° True N
                    </div>
                  </div>
                  <div className="p-2 rounded bg-muted/50 border border-border/50">
                    <div className="text-muted-foreground mb-1">Sun azimuth</div>
                    <div className="font-mono text-amber-400">{sunBearingDeg.toFixed(1)}°</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* EXIF status badge */}
          {exifState === 'gps' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20 text-xs text-green-400">
              <Satellite className="w-3.5 h-3.5 shrink-0" />
              Time read from GPS — already in UTC
            </div>
          )}
          {exifState === 'offset' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-cyber-primary/10 border border-cyber-primary/20 text-xs text-cyber-primary">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Time detected from photo and converted to UTC ({photoMetadata!.utcOffset})
            </div>
          )}
          {exifState === 'local' && (
            <div className="space-y-2 px-3 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <div className="flex items-center gap-2 text-xs text-yellow-400">
                <Info className="w-3.5 h-3.5 shrink-0" />
                Local time detected — select your UTC offset to convert
              </div>
              <select
                className="w-full text-xs rounded border border-border bg-background px-2 py-1.5 text-foreground"
                value={manualOffsetMinutes}
                onChange={(e) => setManualOffsetMinutes(Number(e.target.value))}
              >
                {UTC_OFFSET_OPTIONS.map((opt) => (
                  <option key={opt.minutes} value={opt.minutes}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* GPS coordinates */}
          {photoMetadata?.gpsCoords && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
              <div className="flex items-center gap-2 min-w-0">
                <MapPin className="w-3.5 h-3.5 text-green-400 shrink-0" />
                <span className="text-xs text-green-400 truncate">
                  {formatCoords(photoMetadata.gpsCoords.lat, photoMetadata.gpsCoords.lng)}
                </span>
              </div>
              <button
                onClick={handleCopyCoords}
                className="text-xs text-green-400/70 hover:text-green-400 transition-colors shrink-0 px-1.5 py-0.5 rounded hover:bg-green-500/10"
                title="Copy decimal coordinates"
              >
                Copy
              </button>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="photo-date" className="flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              Photo Date (UTC) *
            </Label>
            <Input
              id="photo-date"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="cyber-border"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="photo-time" className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Time (UTC)
            </Label>
            <Input
              id="photo-time"
              type="time"
              value={selectedTime}
              onChange={(e) => setSelectedTime(e.target.value)}
              className="cyber-border"
            />
          </div>
        </div>

        {/* Analyze button */}
        <Button
          variant="cyber-solid"
          size="lg"
          className="w-full"
          onClick={handleAnalyze}
          disabled={!isReady || isAnalyzing}
        >
          <MapPin className="w-4 h-4" />
          {isAnalyzing ? 'Analyzing...' : 'Estimate Location'}
        </Button>

        {!isReady && (
          <p className="text-xs text-center text-muted-foreground">
            {points.length < 3
              ? `Mark ${3 - points.length} more point${3 - points.length === 1 ? '' : 's'} on the image`
              : 'Select the photo date to continue'
            }
          </p>
        )}
      </div>
    </Card>
  );
};
