import React from 'react';
import { cls, layout, type FillClass, type StrokeClass } from './tokens';

export type BoxVariant = 'default' | 'primary' | 'muted';

export interface BoxProps {
  x: number;
  y: number;
  width: number;
  height: number;
  title?: string;
  subtitle?: string;
  variant?: BoxVariant;
  fillClass?: FillClass;
  strokeClass?: StrokeClass;
  textClass?: FillClass;
  rx?: number;
}

const variantMap: Record<BoxVariant, { fill: FillClass; stroke: StrokeClass; text: FillClass }> = {
  default: { fill: 'surface', stroke: 'stroke', text: 'text' },
  primary: { fill: 'primary', stroke: 'primary', text: 'surface' },
  muted: { fill: 'surfaceStrong', stroke: 'stroke', text: 'textMuted' },
};

export function Box({
  x,
  y,
  width,
  height,
  title,
  subtitle,
  variant = 'default',
  fillClass,
  strokeClass,
  textClass,
  rx = layout.boxRadius,
}: BoxProps) {
  const v = variantMap[variant];
  const fill = fillClass ?? v.fill;
  const stroke = strokeClass ?? v.stroke;
  const text = textClass ?? v.text;

  const cx = x + width / 2;
  const titleY = subtitle ? y + height / 2 - 4 : y + height / 2 + 4;
  const subtitleY = y + height / 2 + 12;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={rx}
        ry={rx}
        className={`${cls.fill[fill]} ${cls.stroke[stroke]}`}
        strokeWidth={layout.boxStrokeWidth}
      />
      {title && (
        <text
          x={cx}
          y={titleY}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={layout.titleFontSize}
          fontFamily={layout.fontFamily}
          fontWeight={600}
          className={cls.fill[text]}
        >
          {title}
        </text>
      )}
      {subtitle && (
        <text
          x={cx}
          y={subtitleY}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={layout.subtitleFontSize}
          fontFamily={layout.fontFamily}
          className={cls.fill[text]}
          opacity={0.75}
        >
          {subtitle}
        </text>
      )}
    </g>
  );
}
