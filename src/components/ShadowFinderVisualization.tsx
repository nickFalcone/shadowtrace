import React, { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, LayersControl, useMap } from 'react-leaflet';
import * as L from 'leaflet';
import 'leaflet.heat';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, Zap } from 'lucide-react';
import {
  ShadowFinderPoint,
  ShadowAnalysisResult,
  AzimuthConstraint,
  applyAzimuthConstraint,
  VISIBLE_BAND_RAD,
  NIGHT_LIKELIHOOD,
} from '@/lib/shadowfinder';
import { computeFovDeg } from '@/lib/exif';

type HeatPoint = [number, number, number];

const LIKELIHOOD_CUTOFF = VISIBLE_BAND_RAD;

const WARM_GRADIENT: Record<string, string> = { 0.4: '#FF4500', 0.65: '#FF9500', 0.85: '#FFD700', 1.0: '#FFFF33' };
const COOL_GRADIENT: Record<string, string> = { 0.4: '#1E90FF', 0.7: '#00E5FF', 1.0: '#FFFFFF' };

interface ShadowFinderVisualizationProps {
  analysisData: ShadowAnalysisResult;
  knownTime: Date;
  measurements: {
    objectHeight: number;
    shadowLength: number;
  };
  secondAnalysisData?: ShadowAnalysisResult | null;
  secondKnownTime?: Date | null;
  secondMeasurements?: {
    objectHeight: number;
    shadowLength: number;
  } | null;
  mode?: 'single' | 'intersection';
  azimuthConstraint?: AzimuthConstraint | null;
  secondAzimuthConstraint?: AzimuthConstraint | null;
  gpsCoords?: { lat: number; lng: number } | null;
  secondGpsCoords?: { lat: number; lng: number } | null;
  compassBearing?: number | null;
  compassRef?: 'T' | 'M' | null;
  focalLength35mm?: number | null;
  secondCompassBearing?: number | null;
  secondCompassRef?: 'T' | 'M' | null;
  secondFocalLength35mm?: number | null;
}

function filterPoints(
  points: ShadowFinderPoint[],
  constraint: AzimuthConstraint | null | undefined
): { visible: ShadowFinderPoint[]; fallback: boolean } {
  const base = points.filter(p => p.likelihood !== NIGHT_LIKELIHOOD && p.likelihood <= LIKELIHOOD_CUTOFF);
  if (!constraint?.enabled) return { visible: base, fallback: false };
  const filtered = applyAzimuthConstraint(base, constraint);
  if (filtered.length === 0) return { visible: base, fallback: true };
  return { visible: filtered, fallback: false };
}

function toHeatPoints(points: ShadowFinderPoint[]): HeatPoint[] {
  return points.map(p => [p.lat, p.lng, 1 - p.likelihood / LIKELIHOOD_CUTOFF]);
}

interface HeatmapLayerProps {
  points: HeatPoint[];
  gradient: Record<string, string>;
  primary?: boolean;
}

function HeatmapLayer({ points, gradient, primary = false }: HeatmapLayerProps) {
  const map = useMap();
  const hasFit = useRef(false);

  // Add a Leaflet heatmap layer to the map (imperative third-party library API).
  // Cleanup: remove the layer when deps change or the component unmounts to prevent duplicate overlays.
  // Deps: [points, gradient, map, primary] — recreate whenever any rendering input changes.
  useEffect(() => {
    const heat = L.heatLayer(points, { radius: 18, blur: 25, maxZoom: 8, gradient });
    heat.addTo(map);

    if (primary && !hasFit.current && points.length > 0) {
      let minLat = points[0][0], maxLat = points[0][0];
      let minLng = points[0][1], maxLng = points[0][1];
      for (const p of points) {
        if (p[0] < minLat) minLat = p[0];
        if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLng) minLng = p[1];
        if (p[1] > maxLng) maxLng = p[1];
      }
      map.fitBounds([[minLat, minLng], [maxLat, maxLng]]);
      hasFit.current = true;
    }

    return () => { map.removeLayer(heat); };
  }, [points, gradient, map, primary]);

  return null;
}

interface GpsMarkerLayerProps {
  coords: { lat: number; lng: number };
  label: string;
}

function GpsMarkerLayer({ coords, label }: GpsMarkerLayerProps) {
  const map = useMap();

  // Add a Leaflet marker to the map for the GPS pin (imperative third-party library API).
  // Cleanup: remove the marker to prevent duplicate pins when coords or label change.
  // Deps: [coords.lat, coords.lng, map, label] — recreate if position or label changes.
  useEffect(() => {
    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #00e5ff;
        border: 2px solid #ffffff;
        box-shadow: 0 0 6px #00e5ff;
      "></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });

    const popupEl = document.createElement('div');
    const labelEl = document.createElement('b');
    labelEl.textContent = label;
    popupEl.appendChild(labelEl);
    popupEl.appendChild(document.createElement('br'));
    popupEl.appendChild(document.createTextNode(
      `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`
    ));

    const marker = L.marker([coords.lat, coords.lng], { icon })
      .addTo(map)
      .bindPopup(popupEl);

    return () => { map.removeLayer(marker); };
  }, [coords.lat, coords.lng, map, label]);

  return null;
}

function destinationPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceKm: number
): [number, number] {
  const R = 6371;
  const d = distanceKm / R;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ)
  );
  const λ2Raw =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
      Math.cos(d) - Math.sin(φ1) * Math.sin(φ2)
    );
  const λ2 = ((λ2Raw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return [(φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI];
}

interface GpsConeLayerProps {
  coords: { lat: number; lng: number };
  bearingDeg: number;
  fovDeg: number;
}

function GpsConeLayer({ coords, bearingDeg, fovDeg }: GpsConeLayerProps) {
  const map = useMap();

  // Add a Leaflet polygon representing the camera FOV cone (imperative third-party library API).
  // Cleanup: remove the polygon to prevent duplicate cones when geometry changes.
  // Deps: [coords.lat, coords.lng, bearingDeg, fovDeg, map] — recreate if any cone input changes.
  useEffect(() => {
    const RADIUS_KM = 10;
    const STEPS = 30;
    const halfFov = fovDeg / 2;
    const arcPoints: [number, number][] = [];

    for (let i = 0; i <= STEPS; i++) {
      const bearing = bearingDeg - halfFov + (fovDeg * i) / STEPS;
      arcPoints.push(destinationPoint(coords.lat, coords.lng, bearing, RADIUS_KM));
    }

    const polygon = L.polygon(
      [[coords.lat, coords.lng], ...arcPoints],
      {
        color: '#00e5ff',
        fillColor: '#00e5ff',
        fillOpacity: 0.12,
        opacity: 0.5,
        weight: 1,
      }
    ).addTo(map);

    return () => { map.removeLayer(polygon); };
  }, [coords.lat, coords.lng, bearingDeg, fovDeg, map]);

  return null;
}

export const ShadowFinderVisualization: React.FC<ShadowFinderVisualizationProps> = ({
  analysisData,
  knownTime,
  measurements,
  secondAnalysisData,
  secondKnownTime,
  secondMeasurements,
  mode = 'single',
  azimuthConstraint,
  secondAzimuthConstraint,
  gpsCoords,
  secondGpsCoords,
  compassBearing,
  compassRef,
  focalLength35mm,
  secondCompassBearing,
  secondCompassRef,
  secondFocalLength35mm,
}) => {
  const { visible: firstVisible, fallback: firstFallback } = useMemo(
    () => filterPoints(analysisData.points, azimuthConstraint),
    [analysisData, azimuthConstraint]
  );

  const { visible: secondVisible, fallback: secondFallback } = useMemo(() => {
    if (!secondAnalysisData) return { visible: [], fallback: false };
    return filterPoints(secondAnalysisData.points, secondAzimuthConstraint);
  }, [secondAnalysisData, secondAzimuthConstraint]);

  const { firstHeat, secondHeat, intersectionHeat, hasIntersection } = useMemo(() => {
    if (mode === 'single') {
      return { firstHeat: toHeatPoints(firstVisible), secondHeat: [], intersectionHeat: [], hasIntersection: false };
    }

    const firstMap = new Map<string, ShadowFinderPoint>();
    for (const p of firstVisible) {
      firstMap.set(`${p.lat.toFixed(1)},${p.lng.toFixed(1)}`, p);
    }

    const intersectionPoints: HeatPoint[] = [];
    for (const p of secondVisible) {
      const key = `${p.lat.toFixed(1)},${p.lng.toFixed(1)}`;
      const firstPoint = firstMap.get(key);
      if (firstPoint) {
        const combinedLikelihood = Math.max(firstPoint.likelihood, p.likelihood);
        intersectionPoints.push([p.lat, p.lng, 1 - combinedLikelihood / LIKELIHOOD_CUTOFF]);
      }
    }

    if (intersectionPoints.length > 0) {
      return { firstHeat: [], secondHeat: [], intersectionHeat: intersectionPoints, hasIntersection: true };
    }

    return {
      firstHeat: toHeatPoints(firstVisible),
      secondHeat: toHeatPoints(secondVisible),
      intersectionHeat: [],
      hasIntersection: false,
    };
  }, [mode, firstVisible, secondVisible]);

  if (!analysisData) return null;

  const showFallbackWarning = firstFallback || secondFallback || (mode === 'intersection' && !hasIntersection && secondAnalysisData);

  return (
    <Card className="cyber-border overflow-hidden">
      <div className="p-4 border-b border-border/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-cyber-primary" />
            <div>
              <h3 className="text-sm font-semibold">
                {mode === 'single' ? 'ShadowFinder Analysis' : 'Dual Photo Intersection'}
              </h3>
              <p className="text-xs text-muted-foreground">
                {mode === 'single'
                  ? `Showing ${analysisData.statistics.visibleBandPoints} high-probability locations`
                  : 'Intersection analysis for maximum precision'
                }
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Badge variant="outline" className="border-cyber-primary/30 text-cyber-primary">
              <Zap className="w-3 h-3 mr-1" />
              {mode === 'single'
                ? `${analysisData.statistics.ultraTightBandPoints} ultra-precise`
                : 'Dual Photo Mode'
              }
            </Badge>
            {azimuthConstraint?.enabled && !firstFallback && (
              <Badge variant="outline" className="border-cyber-secondary/30 text-cyber-secondary">
                🧭 Azimuth-constrained
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div style={{ height: '600px', position: 'relative', zIndex: 0 }}>
        <MapContainer
          center={[20, 0]}
          zoom={1}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={true}
        >
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="Streets">
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Satellite">
              <TileLayer
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution='Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
              />
            </LayersControl.BaseLayer>
          </LayersControl>

          {mode === 'single' && firstHeat.length > 0 && (
            <HeatmapLayer points={firstHeat} gradient={WARM_GRADIENT} primary />
          )}

          {mode === 'intersection' && hasIntersection && intersectionHeat.length > 0 && (
            <HeatmapLayer points={intersectionHeat} gradient={WARM_GRADIENT} primary />
          )}

          {mode === 'intersection' && !hasIntersection && firstHeat.length > 0 && (
            <HeatmapLayer points={firstHeat} gradient={WARM_GRADIENT} primary />
          )}

          {mode === 'intersection' && !hasIntersection && secondHeat.length > 0 && (
            <HeatmapLayer points={secondHeat} gradient={COOL_GRADIENT} />
          )}

          {gpsCoords && (
            <GpsMarkerLayer coords={gpsCoords} label="Photo 1 GPS" />
          )}

          {secondGpsCoords && (
            <GpsMarkerLayer coords={secondGpsCoords} label="Photo 2 GPS" />
          )}

          {/* null compassRef treated as True per EXIF spec §4.6.6; magnetic-only cameras that omit the tag are an acceptable false-positive risk */}
          {gpsCoords && compassBearing != null && compassRef !== 'M' && (
            <GpsConeLayer
              coords={gpsCoords}
              bearingDeg={compassBearing}
              fovDeg={computeFovDeg(focalLength35mm ?? null)}
            />
          )}

          {secondGpsCoords && secondCompassBearing != null && secondCompassRef !== 'M' && (
            <GpsConeLayer
              coords={secondGpsCoords}
              bearingDeg={secondCompassBearing}
              fovDeg={computeFovDeg(secondFocalLength35mm ?? null)}
            />
          )}
        </MapContainer>
      </div>

      <div className="p-4 border-t border-border/50">
        <div className="text-xs text-muted-foreground text-center">
          {mode === 'single'
            ? 'Bright yellow shows ultra-precise matches. Orange areas show probable locations.'
            : hasIntersection
              ? 'Single heatmap showing the intersection of both analyses — highest precision region.'
              : 'Yellow = First photo band. Blue = Second photo band. No intersection found.'
          }
        </div>
        {showFallbackWarning && (
          <div className="text-xs text-amber-400 text-center mt-1">
            {(firstFallback || secondFallback)
              ? 'Azimuth constraint produced no matches — showing shadow band only'
              : 'No intersection found — showing both shadow bands'
            }
          </div>
        )}
      </div>
    </Card>
  );
};
