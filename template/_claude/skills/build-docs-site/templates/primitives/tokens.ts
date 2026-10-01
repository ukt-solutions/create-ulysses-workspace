/**
 * Diagram tokens for the build-docs-site skill.
 *
 * Two exports:
 *   - `colors`: hex values, used where class-based styling can't reach
 *     (e.g., SVG <marker> contents in shadow tree).
 *   - `cls`: class name maps, used everywhere else. The matching CSS
 *     classes are defined in the site's custom.css.
 *
 * Why class names instead of CSS variables in fill/stroke attributes:
 * Chromium's SVG paint pipeline does not reliably resolve
 * `fill="var(--x)"` or `style={{fill: 'var(--x)'}}`. Class selectors
 * with `fill: var(--x)` rules work consistently because the cascade
 * resolves the variable before paint.
 */

export const colors = {
  // Semantic colors — light mode hex fallbacks.
  // Kept in sync with --dx-* CSS variables in custom.css.
  primary: '#3B6EA8',
  accent: '#D97757',
  surface: '#FFFFFF',
  surfaceStrong: '#F2F2F2',
  text: '#1A1A1A',
  textMuted: '#666666',
  stroke: '#CCCCCC',
  strokeStrong: '#888888',
} as const;

export const cls = {
  fill: {
    primary: 'dx-fill-primary',
    accent: 'dx-fill-accent',
    surface: 'dx-fill-surface',
    surfaceStrong: 'dx-fill-surface-strong',
    text: 'dx-fill-text',
    textMuted: 'dx-fill-text-muted',
    stroke: 'dx-fill-stroke',
    strokeStrong: 'dx-fill-stroke-strong',
  },
  stroke: {
    primary: 'dx-stroke-primary',
    accent: 'dx-stroke-accent',
    surface: 'dx-stroke-surface',
    surfaceStrong: 'dx-stroke-surface-strong',
    text: 'dx-stroke-text',
    textMuted: 'dx-stroke-text-muted',
    stroke: 'dx-stroke-stroke',
    strokeStrong: 'dx-stroke-stroke-strong',
  },
} as const;

export type ColorToken = keyof typeof colors;
export type FillClass = keyof typeof cls.fill;
export type StrokeClass = keyof typeof cls.stroke;

// Layout constants shared across primitives.
export const layout = {
  boxRadius: 6,
  boxStrokeWidth: 1.5,
  arrowStrokeWidth: 1.5,
  arrowheadSize: 8,
  titleFontSize: 14,
  subtitleFontSize: 11,
  captionFontSize: 12,
  fontFamily: 'inherit',
} as const;
