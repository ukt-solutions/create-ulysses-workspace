import React from 'react';

export interface DiagramContainerProps {
  /** SVG viewport width in pixels. */
  width: number;
  /** SVG viewport height in pixels. */
  height: number;
  /** Optional caption shown below the diagram. */
  caption?: string;
  /** Optional accessible label for the diagram. */
  ariaLabel?: string;
  children: React.ReactNode;
}

/**
 * Outer wrapper for every diagram in the documentation site.
 *
 * Provides:
 *   - Consistent padding via the `dx-diagram-container` CSS class
 *   - Theme-aware background (light cream / dark surface) defined in custom.css
 *   - Caption rendering below the diagram
 *   - Accessible labelling
 *   - viewBox-based responsive sizing (the SVG scales to its container)
 */
export function DiagramContainer({
  width,
  height,
  caption,
  ariaLabel,
  children,
}: DiagramContainerProps) {
  return (
    <figure className="dx-diagram-container">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={ariaLabel ?? caption ?? 'Diagram'}
        preserveAspectRatio="xMidYMid meet"
      >
        {children}
      </svg>
      {caption && <figcaption className="dx-diagram-caption">{caption}</figcaption>}
    </figure>
  );
}
