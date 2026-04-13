import React from 'react';
import { cls, layout, type FillClass, type StrokeClass } from './tokens';

export interface RegionProps {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  fillClass?: FillClass;
  strokeClass?: StrokeClass;
  labelClass?: FillClass;
  dashed?: boolean;
  rx?: number;
  children?: React.ReactNode;
}

/**
 * A grouped, labelled container that visually scopes a set of related
 * elements. Use Region when you want to show "these things belong
 * together" without committing to a Box-as-foreground meaning.
 *
 * The label sits above the top-left corner of the region.
 * Children render inside the region's coordinate space.
 */
export function Region({
  x,
  y,
  width,
  height,
  label,
  fillClass = 'surfaceStrong',
  strokeClass = 'stroke',
  labelClass = 'textMuted',
  dashed = true,
  rx = layout.boxRadius,
  children,
}: RegionProps) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={rx}
        ry={rx}
        className={`${cls.fill[fillClass]} ${cls.stroke[strokeClass]}`}
        strokeWidth={layout.boxStrokeWidth}
        strokeDasharray={dashed ? '4 3' : undefined}
        opacity={0.4}
      />
      {label && (
        <text
          x={x + 8}
          y={y - 6}
          fontSize={layout.captionFontSize}
          fontFamily={layout.fontFamily}
          fontWeight={600}
          className={cls.fill[labelClass]}
        >
          {label}
        </text>
      )}
      {children}
    </g>
  );
}
