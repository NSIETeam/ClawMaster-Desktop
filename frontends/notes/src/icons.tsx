/**
 * Inline glyph set for the notes panel.
 *
 * Drawn on the platform's own conventions — a 16px grid, `currentColor`, round caps and an
 * `aria-hidden` decorative role — so the panel carries no raster asset and no color literal,
 * and every glyph follows the active skin. Action icons sit inside labelled buttons, so the
 * accessible name never depends on the drawing.
 */
import type { ReactNode } from 'react';

interface GlyphProps {
  /** Square edge in px; the glyph grid is 16. */
  size?: number | undefined;
  className?: string | undefined;
}

/** Secondary note actions. */
export function MoreIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <circle cx="3.5" cy="8" r=".7" fill="currentColor" />
    <circle cx="8" cy="8" r=".7" fill="currentColor" />
    <circle cx="12.5" cy="8" r=".7" fill="currentColor" />
  </Glyph>;
}

function Glyph({ size = 14, className, children }: GlyphProps & { children: ReactNode }): ReactNode {
  return <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>;
}

/** Disclosure chevron; the tree rotates it for an open folder. */
export function ChevronIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}><path d="M6 3.5 10.5 8 6 12.5" /></Glyph>;
}

/** Closed folder. */
export function FolderIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M1.75 12.25v-8a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .8.4l.9 1.2h5.7a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1Z" />
  </Glyph>;
}

/** Open folder. */
export function FolderOpenIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M1.75 12.25v-8a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .8.4l.9 1.2h5.7a1 1 0 0 1 1 1v1.4" />
    <path d="M1.75 12.25 3.4 7.2h11.1l-1.65 5.05a1 1 0 0 1-.95.7H2.7a1 1 0 0 1-.95-.7Z" />
  </Glyph>;
}

/** A Markdown note: a sheet with text lines. */
export function NoteIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M4 1.75h5.1L12.5 5.2v9.05a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1Z" />
    <path d="M9 1.75V5.4h3.4" />
    <path d="M6 8.6h4M6 11.1h4" />
  </Glyph>;
}

/** A canvas file: a framed board. */
export function CanvasIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.4" />
    <path d="M6.2 2.75v10.5M2.25 6.2h4" />
  </Glyph>;
}

/** Search field glyph. */
export function SearchIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <circle cx="6.9" cy="6.9" r="4.15" />
    <path d="M10 10 13.6 13.6" />
  </Glyph>;
}

/** Today's daily note. */
export function CalendarIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <rect x="2.25" y="3.4" width="11.5" height="10.1" rx="1.4" />
    <path d="M2.25 6.6h11.5M5.6 1.9v3M10.4 1.9v3" />
  </Glyph>;
}

/** Create a note. */
export function PlusIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}><path d="M8 3.4v9.2M3.4 8h9.2" /></Glyph>;
}

/** Commit the open draft. */
export function SaveIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M8 2.2v6.6" />
    <path d="M5.4 6.3 8 8.9l2.6-2.6" />
    <path d="M2.6 10.6v1.9a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-1.9" />
  </Glyph>;
}

/** Rename: a text caret over a line. */
export function RenameIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M3 12.6h10" />
    <path d="M6.1 3.1h6.4M9.3 3.1v7.1" />
    <path d="M5.4 3.1 7.5 10.2 9.6 3.1" />
  </Glyph>;
}

/** Read as rendered Markdown. */
export function PreviewIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M1.6 8S3.9 3.9 8 3.9 14.4 8 14.4 8 12.1 12.1 8 12.1 1.6 8 1.6 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </Glyph>;
}

/** Return to editing. */
export function EditIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M11.1 2.5 13.5 4.9 5.9 12.5l-3 .6.6-3 7.6-7.6Z" />
    <path d="M10 3.6 12.4 6" />
  </Glyph>;
}

/** Delete a note. */
export function TrashIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M2.8 4.4h10.4M6.4 4.4V2.9a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v1.5" />
    <path d="M4.2 4.4l.7 8.5a1 1 0 0 0 1 .93h4.2a1 1 0 0 0 1-.93l.7-8.5" />
  </Glyph>;
}

/** Pending proposals. */
export function ProposalIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M8 1.9v1.7M3.7 3.7l1.2 1.2M12.3 3.7l-1.2 1.2M1.9 8h1.7M12.4 8h1.7" />
    <path d="M5.4 12.6c0-1.7 1.1-2.3 1.1-3.5a1.5 1.5 0 0 1 3 0c0 1.2 1.1 1.8 1.1 3.5" />
    <path d="M6.3 14.1h3.4" />
  </Glyph>;
}

/** Backlinks: an arrow entering a box. */
export function BacklinkIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M9.6 3.4h3a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-9.2a1 1 0 0 1-1-1v-7.2a1 1 0 0 1 1-1h3" />
    <path d="M8 1.9v6.4M5.8 6.2 8 8.4l2.2-2.2" />
  </Glyph>;
}

/** Tags. */
export function TagIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <path d="M7.4 2.1H3.1a1 1 0 0 0-1 1v4.3a1 1 0 0 0 .3.7l5.5 5.5a1 1 0 0 0 1.4 0l4.3-4.3a1 1 0 0 0 0-1.4L8.1 2.4a1 1 0 0 0-.7-.3Z" />
    <circle cx="5.4" cy="5.4" r="0.9" />
  </Glyph>;
}

/** Read-only notice. */
export function InfoIcon({ size, className }: GlyphProps): ReactNode {
  return <Glyph size={size} className={className}>
    <circle cx="8" cy="8" r="6.1" />
    <path d="M8 7.3v3.6M8 5.1h.01" />
  </Glyph>;
}
