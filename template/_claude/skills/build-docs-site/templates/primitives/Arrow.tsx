import React from 'react';
import { colors, cls, layout, type StrokeClass } from './tokens';

export interface ArrowProps {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * If true, the arrow bends at a right angle.
   * The corner is placed based on `elbowAxis`:
   *   - 'horizontal-first': go horizontally to x2, then vertically to y2
   *   - 'vertical-first':   go vertically to y2, then horizontally to x2
   */
  elbow?: boolean;
  elbowAxis?: 'horizontal-first' | 'vertical-first';
  strokeClass?: StrokeClass;
  /** Override the marker fill. SVG markers can't be styled via parent CSS classes. */
  markerColor?: string;
  strokeWidth?: number;
  dashed?: boolean;
  /** Unique marker id suffix so multiple arrows can coexist with different colors. */
  markerId?: string;
}

/**
 * Note on arrowhead markers:
 * SVG <marker> contents live in a shadow tree that does not inherit
 * CSS classes from the host document. The marker fill must be a literal
 * value. We default to the `text` color hex from tokens. If you need a
 * theme-aware arrowhead, render two markers (one per theme) and switch
 * via media query, or accept the cosmetic mismatch.
 */
export function Arrow({
  x1,
  y1,
  x2,
  y2,
  elbow = false,
  elbowAxis = 'horizontal-first',
  strokeClass = 'strokeStrong',
  markerColor = colors.text,
  strokeWidth = layout.arrowStrokeWidth,
  dashed = false,
  markerId = 'default',
}: ArrowProps) {
  const id = `dx-arrowhead-${markerId}`;

  let path: string;
  if (elbow) {
    if (elbowAxis === 'horizontal-first') {
      path = `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}`;
    } else {
      path = `M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`;
    }
  } else {
    path = `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  return (
    <g>
      <defs>
        <marker
          id={id}
          markerWidth={layout.arrowheadSize}
          markerHeight={layout.arrowheadSize}
          refX={layout.arrowheadSize - 1}
          refY={layout.arrowheadSize / 2}
          orient="auto-start-reverse"
        >
          <path
            d={`M 0 0 L ${layout.arrowheadSize} ${layout.arrowheadSize / 2} L 0 ${layout.arrowheadSize} z`}
            fill={markerColor}
          />
        </marker>
      </defs>
      <path
        d={path}
        fill="none"
        className={cls.stroke[strokeClass]}
        strokeWidth={strokeWidth}
        strokeDasharray={dashed ? '4 3' : undefined}
        markerEnd={`url(#${id})`}
      />
    </g>
  );
}
