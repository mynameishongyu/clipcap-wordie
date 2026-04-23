'use client';

import JSZip from 'jszip';
import type {
  DocBlock,
  DocSegment,
  ImageSegment,
  ParsedDocument,
  ParagraphBlock,
  TableBlock,
  TableCell,
  TableRow,
  TextSegment,
  TextStyleSnapshot,
} from '@/src/types/docx-preview';

function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function localNameOf(node: Node | null) {
  if (!node) {
    return '';
  }

  const elementLike = node as Node & { localName?: string };
  if (elementLike.localName) {
    return elementLike.localName;
  }

  return node.nodeName.split(':').pop() ?? node.nodeName;
}

function getElementChildren(node: Node) {
  const children: Element[] = [];

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === child.ELEMENT_NODE) {
      children.push(child as Element);
    }
  }

  return children;
}

function getAttributeLocal(element: Element, localName: string) {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!attribute) {
      continue;
    }

    const attributeLocalName = attribute.localName ?? attribute.name.split(':').pop();
    if (attributeLocalName === localName) {
      return attribute.value;
    }
  }

  return '';
}

function findFirstDescendant(root: Element | XMLDocument, localName: string) {
  const queue: Element[] = [];

  if ('documentElement' in root) {
    if (root.documentElement) {
      queue.push(root.documentElement);
    }
  } else {
    queue.push(root);
  }

  while (queue.length > 0) {
    const element = queue.shift();
    if (!element) {
      continue;
    }

    if (localNameOf(element) === localName) {
      return element;
    }

    queue.push(...getElementChildren(element));
  }

  return null;
}

function getElementPath(node: Element, stopAt?: Element | null) {
  const path: number[] = [];
  let current: Node | null = node;

  while (current && current.nodeType === current.ELEMENT_NODE) {
    const parent = current.parentNode;
    if (!parent || parent.nodeType !== parent.ELEMENT_NODE) {
      break;
    }

    const parentElement = parent as Element;
    const siblings = getElementChildren(parentElement);
    const index = siblings.findIndex((candidate) => candidate === current);
    path.unshift(index);

    if (stopAt && parentElement === stopAt) {
      break;
    }

    current = parentElement;
  }

  return path;
}

function resolvePartPath(basePartPath: string, target: string) {
  const baseSegments = basePartPath.split('/');
  baseSegments.pop();

  for (const segment of target.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      baseSegments.pop();
    } else {
      baseSegments.push(segment);
    }
  }

  return baseSegments.join('/');
}

function emuToPx(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.round(parsed / 9525);
}

function parseTextStyle(run: Element) {
  const runProperties = getElementChildren(run).find((child) => localNameOf(child) === 'rPr');
  const style: TextStyleSnapshot = {};

  if (!runProperties) {
    return style;
  }

  getElementChildren(runProperties).forEach((property) => {
    const name = localNameOf(property);

    if (name === 'b') {
      style.bold = true;
    }

    if (name === 'i') {
      style.italic = true;
    }

    if (name === 'u') {
      style.underline = true;
    }

    if (name === 'color') {
      const value = getAttributeLocal(property, 'val');
      if (value) {
        style.color = `#${value}`;
      }
    }

    if (name === 'highlight' || name === 'shd') {
      const fill = getAttributeLocal(property, 'fill') || getAttributeLocal(property, 'val');
      if (fill && fill !== 'auto') {
        style.backgroundColor = `#${fill}`;
      }
    }

    if (name === 'sz') {
      const value = Number(getAttributeLocal(property, 'val'));
      if (Number.isFinite(value)) {
        style.fontSizePt = value / 2;
      }
    }

    if (name === 'rFonts') {
      const fontFamily =
        getAttributeLocal(property, 'ascii') ||
        getAttributeLocal(property, 'eastAsia') ||
        getAttributeLocal(property, 'hAnsi');

      if (fontFamily) {
        style.fontFamily = fontFamily;
      }
    }
  });

  return style;
}

function getParagraphAlign(paragraph: Element) {
  const paragraphProperties = getElementChildren(paragraph).find((child) => localNameOf(child) === 'pPr');
  if (!paragraphProperties) {
    return 'left';
  }

  const justification = getElementChildren(paragraphProperties).find((child) => localNameOf(child) === 'jc');
  const value = justification ? getAttributeLocal(justification, 'val') : '';
  if (value === 'center' || value === 'right' || value === 'justify') {
    return value;
  }

  return 'left';
}

function createImageObjectUrl(blob: Blob) {
  if (typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(blob);
  }

  return '';
}

function getTextFromInlineNode(node: Element) {
  const name = localNameOf(node);

  if (name === 't') {
    return node.textContent ?? '';
  }

  if (name === 'tab') {
    return '\t';
  }

  if (name === 'br' || name === 'cr') {
    return '\n';
  }

  return '';
}

const transparentInlineNodeNames = new Set([
  'bookmarkStart',
  'bookmarkEnd',
  'commentRangeStart',
  'commentRangeEnd',
  'commentReference',
  'proofErr',
  'permStart',
  'permEnd',
  'moveFromRangeStart',
  'moveFromRangeEnd',
  'moveToRangeStart',
  'moveToRangeEnd',
]);

const transparentParagraphNodeNames = new Set(['hyperlink', 'ins', 'moveTo', 'customXml', 'smartTag', 'sdt', 'sdtContent', 'fldSimple']);
const skippedParagraphNodeNames = new Set(['del', 'moveFrom']);

async function parseDrawingImage(
  drawing: Element,
  relationships: Map<string, string>,
  zip: JSZip,
  documentRoot: Element,
) {
  const blip = findFirstDescendant(drawing, 'blip');
  if (!blip) {
    return null;
  }

  const relId = getAttributeLocal(blip, 'embed');
  if (!relId) {
    return null;
  }

  const target = relationships.get(relId);
  if (!target) {
    return null;
  }

  const partPath = resolvePartPath('word/document.xml', target);
  const file = zip.file(partPath);
  if (!file) {
    return null;
  }

  const blob = await file.async('blob');
  const extent = findFirstDescendant(drawing, 'extent');
  const docPr = findFirstDescendant(drawing, 'docPr');

  const image: ImageSegment = {
    id: `image:${getElementPath(blip, documentRoot).join('.')}`,
    type: 'image',
    locator: {
      path: getElementPath(blip, documentRoot),
      relId,
      target,
    },
    src: createImageObjectUrl(blob),
    altText:
      getAttributeLocal(docPr ?? drawing, 'descr') ||
      getAttributeLocal(docPr ?? drawing, 'title') ||
      getAttributeLocal(docPr ?? drawing, 'name') ||
      undefined,
    style: {
      widthPx: extent ? emuToPx(getAttributeLocal(extent, 'cx')) : undefined,
      heightPx: extent ? emuToPx(getAttributeLocal(extent, 'cy')) : undefined,
    },
  };

  return image;
}

async function parseRunSegments(
  run: Element,
  relationships: Map<string, string>,
  zip: JSZip,
  documentRoot: Element,
) {
  const runPath = getElementPath(run, documentRoot);
  const style = parseTextStyle(run);
  const children = getElementChildren(run);
  const segments: DocSegment[] = [];
  let bufferedText = '';
  let childStart = -1;
  let childEnd = -1;

  function flushTextBuffer() {
    if (!bufferedText) {
      return;
    }

    const textSegment: TextSegment = {
      id: `text:${runPath.join('.')}:${childStart}:${childEnd}:${segments.length}`,
      type: 'text',
      text: bufferedText,
      style,
      locator: {
        path: runPath,
        childStart,
        childEnd,
      },
    };

    segments.push(textSegment);
    bufferedText = '';
    childStart = -1;
    childEnd = -1;
  }

  for (const [index, child] of children.entries()) {
    const childName = localNameOf(child);

    if (childName === 't' || childName === 'tab' || childName === 'br' || childName === 'cr') {
      if (childStart === -1) {
        childStart = index;
      }

      childEnd = index;
      bufferedText += getTextFromInlineNode(child);
      continue;
    }

    if (transparentInlineNodeNames.has(childName)) {
      continue;
    }

    flushTextBuffer();

    if (childName === 'drawing') {
      const image = await parseDrawingImage(child, relationships, zip, documentRoot);
      if (image) {
        segments.push(image);
      }
    }
  }

  flushTextBuffer();
  return segments;
}

async function parseParagraphChildren(
  children: Element[],
  relationships: Map<string, string>,
  zip: JSZip,
  documentRoot: Element,
) {
  const segments: DocSegment[] = [];

  for (const child of children) {
    const name = localNameOf(child);

    if (name === 'r') {
      segments.push(...(await parseRunSegments(child, relationships, zip, documentRoot)));
      continue;
    }

    if (skippedParagraphNodeNames.has(name)) {
      continue;
    }

    if (transparentParagraphNodeNames.has(name)) {
      segments.push(...(await parseParagraphChildren(getElementChildren(child), relationships, zip, documentRoot)));
    }
  }

  return segments;
}

async function parseParagraph(
  paragraph: Element,
  relationships: Map<string, string>,
  zip: JSZip,
  documentRoot: Element,
) {
  const segments = await parseParagraphChildren(getElementChildren(paragraph), relationships, zip, documentRoot);

  const block: ParagraphBlock = {
    id: `paragraph:${getElementPath(paragraph, documentRoot).join('.')}`,
    type: 'paragraph',
    align: getParagraphAlign(paragraph) as ParagraphBlock['align'],
    segments,
  };

  return block;
}

async function parseCell(
  cell: Element,
  relationships: Map<string, string>,
  zip: JSZip,
  documentRoot: Element,
) {
  const blocks: DocBlock[] = [];

  for (const child of getElementChildren(cell)) {
    const name = localNameOf(child);

    if (name === 'p') {
      blocks.push(await parseParagraph(child, relationships, zip, documentRoot));
    }

    if (name === 'tbl') {
      blocks.push(await parseTable(child, relationships, zip, documentRoot));
    }
  }

  const parsedCell: TableCell = {
    id: `cell:${getElementPath(cell, documentRoot).join('.')}`,
    blocks,
  };

  return parsedCell;
}

async function parseTable(
  table: Element,
  relationships: Map<string, string>,
  zip: JSZip,
  documentRoot: Element,
) {
  const rows: TableRow[] = [];

  for (const row of getElementChildren(table).filter((child) => localNameOf(child) === 'tr')) {
    const cells: TableCell[] = [];

    for (const cell of getElementChildren(row).filter((child) => localNameOf(child) === 'tc')) {
      cells.push(await parseCell(cell, relationships, zip, documentRoot));
    }

    rows.push({
      id: `row:${getElementPath(row, documentRoot).join('.')}`,
      cells,
    });
  }

  const block: TableBlock = {
    id: `table:${getElementPath(table, documentRoot).join('.')}`,
    type: 'table',
    rows,
  };

  return block;
}

function parseRelationships(xml: string) {
  const map = new Map<string, string>();
  const document = parseXml(xml);
  const root = document.documentElement;

  getElementChildren(root).forEach((relationship) => {
    const id = getAttributeLocal(relationship, 'Id');
    const target = getAttributeLocal(relationship, 'Target');
    if (id && target) {
      map.set(id, target);
    }
  });

  return map;
}

export async function parseDocxInBrowser(file: File) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentFile = zip.file('word/document.xml');

  if (!documentFile) {
    throw new Error('找不到 word/document.xml，当前文件不是有效的 DOCX。');
  }

  const documentXml = parseXml(await documentFile.async('string'));
  const relationshipsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  const relationships = relationshipsXml ? parseRelationships(relationshipsXml) : new Map();
  const documentRoot = documentXml.documentElement;
  const body = findFirstDescendant(documentXml, 'body');

  if (!body) {
    throw new Error('DOCX 中没有可读取的正文内容。');
  }

  const blocks: DocBlock[] = [];

  for (const child of getElementChildren(body)) {
    const name = localNameOf(child);
    if (name === 'p') {
      blocks.push(await parseParagraph(child, relationships, zip, documentRoot));
    }

    if (name === 'tbl') {
      blocks.push(await parseTable(child, relationships, zip, documentRoot));
    }
  }

  const parsed: ParsedDocument = { blocks };
  return parsed;
}
