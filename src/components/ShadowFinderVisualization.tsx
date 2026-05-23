import React, { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, LayersControl, useMap } from 'react-leaflet';
import * as L from 'leaflet';
import 'leaflet.heat';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, Zap } from 'lucide-react';
import { ShadowFinderPoint, ShadowAnalysisResult, AzimuthConstraint, applyAzimuthConstraint } from '@/lib/shadowfinder';

type HeatPoint = [number, number, number];

const LIKELIHOOD_CUTOFF = 0.15;

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
}

function filterPoints(
  points: ShadowFinderPoint[],
  constraint: AzimuthConstraint | null | undefined
): { visible: ShadowFinderPoint[]; fallback: boolean } {
  const base = points.filter(p => p.likelihood !== -1 && p.likelihood <= LIKELIHOOD_CUTOFF);
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
        intersectionPoints.push([p.lat, p.lng, 1 - combinedLikelihood / 0.15]);
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
