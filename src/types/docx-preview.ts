export interface TextStyleSnapshot {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  backgroundColor?: string;
  fontSizePt?: number;
  fontFamily?: string;
}

export interface ImageStyleSnapshot {
  widthPx?: number;
  heightPx?: number;
}

export interface TextLocator {
  path: number[];
  childStart: number;
  childEnd: number;
}

export interface ImageLocator {
  path: number[];
  relId: string;
  target: string;
}

export interface TextSegment {
  id: string;
  type: 'text';
  text: string;
  style: TextStyleSnapshot;
  locator: TextLocator;
}

export interface ImageSegment {
  id: string;
  type: 'image';
  locator: ImageLocator;
  src: string;
  altText?: string;
  style: ImageStyleSnapshot;
}

export type DocSegment = TextSegment | ImageSegment;

export interface ParagraphBlock {
  id: string;
  type: 'paragraph';
  align?: 'left' | 'center' | 'right' | 'justify';
  segments: DocSegment[];
}

export interface TableCell {
  id: string;
  blocks: DocBlock[];
}

export interface TableRow {
  id: string;
  cells: TableCell[];
}

export interface TableBlock {
  id: string;
  type: 'table';
  rows: TableRow[];
}

export type DocBlock = ParagraphBlock | TableBlock;

export interface ParsedDocument {
  blocks: DocBlock[];
}
