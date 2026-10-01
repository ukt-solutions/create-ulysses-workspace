import React from 'react';
import { cls, layout, type FillClass } from './tokens';

export interface SectionTitleProps {
  x: number;
  y: number;
  text: string;
  textClass?: FillClass;
  fontSize?: number;
  align?: 'start' | 'middle' | 'end';
  bold?: boolean;
}

/**
 * A caption or section heading inside an SVG diagram.
 * Use this for labels above a region or row, not for box titles
 * (which are handled by Box's own title prop).
 */
export function SectionTitle({
  x,
  y,
  text,
  textClass = 'text',
  fontSize = layout.captionFontSize,
  align = 'start',
  bold = true,
}: SectionTitleProps) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={align}
      dominantBaseline="middle"
      fontSize={fontSize}
      fontFamily={layout.fontFamily}
      fontWeight={bold ? 600 : 400}
      className={cls.fill[textClass]}
    >
      {text}
    </text>
  );
}
