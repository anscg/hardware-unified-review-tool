import { useEffect, useState } from 'react';
import type { GerberFileData } from '../store/useStore';
import { fetchFileContent } from '../utils/github';

interface LayerInfo {
  type: string | null;
  side: string | null;
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

interface GerberLayer {
  name: string;
  svg: string;
  info: LayerInfo | null;
  color: string;
  tone: LayerTone;
  visible: boolean;
}

const GERBER_EXTENSIONS = /\.(gbr|ger|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gm1|gm2|gko|drl|xln)$/i;

const DEFAULT_LAYER_COLOR = '#9aa6c1';
const COLOR_BY_LAYER_TYPE: Record<string, string> = {
  copper: '#f39c12',
  mask: '#2ecc71',
  silkscreen: '#f2f2f2',
  paste: '#a6c8ff',
  drill: '#66d9ef',
  mechanical: '#ffd166',
  outline: '#ffd166',
};

type ViewBox = [number, number, number, number];
type LayerTone = 'copper' | 'mask' | 'silkscreen' | 'paste' | 'drill' | 'outline' | 'default';

function formatLayerInfo(info: LayerInfo): string {
  if (!info.type && !info.side) return 'Unknown Layer';
  const side = info.side ? info.side.charAt(0).toUpperCase() + info.side.slice(1) : '';
  const type = info.type ? info.type.charAt(0).toUpperCase() + info.type.slice(1) : '';
  if (side && type) return `${side} ${type}`;
  return type || side || 'Unknown Layer';
}

async function extractZipTextEntries(buffer: ArrayBuffer): Promise<{ name: string; text: string }[]> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entries: { name: string; text: string }[] = [];

  // Find end-of-central-directory
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return entries;

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let cursor = view.getUint32(eocdOffset + 16, true);

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.length) break;
    if (view.getUint32(cursor, true) !== 0x02014b50) break;

    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const filenameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + filenameLen));
    cursor = cursor + 46 + filenameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (!GERBER_EXTENSIONS.test(name)) continue;

    // Find data offset from local header
    if (localHeaderOffset + 30 > bytes.length) continue;
    const localFilenameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localFilenameLen + localExtraLen;

    const raw = bytes.subarray(dataOffset, dataOffset + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      try {
        const stream = new Blob([raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        continue;
      }
    } else {
      continue;
    }

    entries.push({ name: name.split('/').pop()!, text: new TextDecoder().decode(data) });
  }

  return entries;
}

async function renderGerberToSvg(gerberString: string, id: string): Promise<string> {
  const { createParser } = await import('@tracespace/parser');
  const { plot } = await import('@tracespace/plotter');
  const { render } = await import('@tracespace/renderer');

  const parser = createParser();
  parser.feed(gerberString);
  const syntaxTree = parser.results();
  const imageTree = plot(syntaxTree as any);
  const svgTree = render(imageTree) as unknown as HastNode;

  if (!svgTree.properties) {
    svgTree.properties = {};
  }
  svgTree.properties.id = id.replace(/[^a-zA-Z0-9_-]/g, '_');

  return serializeHastNode(svgTree);
}

function getLayerColor(info: LayerInfo | null, name: string): string {
  const tone = getLayerTone(info, name);
  if (tone === 'default') {
    return DEFAULT_LAYER_COLOR;
  }
  return COLOR_BY_LAYER_TYPE[tone];
}

function getLayerTone(info: LayerInfo | null, name: string): LayerTone {
  const type = (info?.type ?? '').toLowerCase();
  if (type in COLOR_BY_LAYER_TYPE) {
    return type as LayerTone;
  }

  const lower = name.toLowerCase();
  if (lower.includes('edge') || lower.includes('outline') || lower.includes('cuts')) {
    return 'outline';
  }
  if (lower.endsWith('.drl') || lower.endsWith('.xln')) {
    return 'drill';
  }

  return 'default';
}

function parseViewBox(svg: string): ViewBox | null {
  const viewBoxMatch = svg.match(/\bviewBox="([^"]+)"/i);
  if (!viewBoxMatch) {
    return null;
  }

  const parts = viewBoxMatch[1]
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));

  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return [parts[0], parts[1], parts[2], parts[3]];
}

function mergeViewBoxes(viewBoxes: ViewBox[]): ViewBox | null {
  if (viewBoxes.length === 0) {
    return null;
  }

  let minX = viewBoxes[0][0];
  let minY = viewBoxes[0][1];
  let maxX = viewBoxes[0][0] + viewBoxes[0][2];
  let maxY = viewBoxes[0][1] + viewBoxes[0][3];

  for (let i = 1; i < viewBoxes.length; i += 1) {
    const [x, y, w, h] = viewBoxes[i];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  return [minX, minY, maxX - minX, maxY - minY];
}

function normalizeLayerSvg(svg: string, color: string, mergedViewBox: ViewBox | null): string {
  let normalized = svg;

  // Drop renderer substrate rect so board does not appear as opaque black panel.
  normalized = normalized.replace(/<rect\b[^>]*\bfill="black"[^>]*>\s*<\/rect>/gi, '');

  if (mergedViewBox) {
    const [x, y, w, h] = mergedViewBox;
    const viewBoxValue = `${x} ${y} ${w} ${h}`;
    normalized = normalized.replace(/\bviewBox="[^"]*"/i, `viewBox="${viewBoxValue}"`);
  }

  normalized = normalized.replace(/\bwidth="[^"]*"/i, 'width="100%"');
  normalized = normalized.replace(/\bheight="[^"]*"/i, 'height="100%"');

  if (!/\bpreserveAspectRatio="[^"]*"/i.test(normalized)) {
    normalized = normalized.replace(/<svg\b/i, '<svg preserveAspectRatio="xMidYMid meet"');
  }

  normalized = normalized.replace(/\bfill="(black|currentColor)"/gi, `fill="${color}"`);
  normalized = normalized.replace(/\bstroke="(black|currentColor)"/gi, `stroke="${color}"`);

  return normalized;
}

function serializeHastNode(node: HastNode): string {
  if (node.type === 'text') {
    return escapeHtml(node.value ?? '');
  }

  if (node.type !== 'element' || !node.tagName) {
    return '';
  }

  const attrs = serializeHastAttributes(node.properties ?? {});
  const children = (node.children ?? []).map(serializeHastNode).join('');

  return attrs.length > 0
    ? `<${node.tagName} ${attrs}>${children}</${node.tagName}>`
    : `<${node.tagName}>${children}</${node.tagName}>`;
}

function serializeHastAttributes(properties: Record<string, unknown>): string {
  return Object.entries(properties)
    .flatMap(([key, value]) => serializeAttributeValue(key, value))
    .join(' ');
}

function serializeAttributeValue(key: string, value: unknown): string[] {
  if (value === null || typeof value === 'undefined' || value === false) {
    return [];
  }

  const attr = key === 'className' ? 'class' : key;

  if (Array.isArray(value)) {
    const joined = value
      .map((item) => String(item))
      .filter((item) => item.length > 0)
      .join(' ');
    if (joined.length === 0) {
      return [];
    }
    return [`${attr}="${escapeHtml(joined)}"`];
  }

  if (value === true) {
    return [attr];
  }

  return [`${attr}="${escapeHtml(String(value))}"`];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function GerberViewer({ file }: { file: GerberFileData }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<GerberLayer[]>([]);
  const [showLayerPanel, setShowLayerPanel] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setLayers([]);

    const load = async () => {
      try {
        const buffer = await fetchFileContent(file.url, undefined, controller.signal);
        if (cancelled) return;

        const whatsThatGerber = (await import('whats-that-gerber')).default;
        let filesToRender: { name: string; text: string }[];

        if (file.type === 'gerber_zip') {
          filesToRender = await extractZipTextEntries(buffer);
          if (filesToRender.length === 0) {
            throw new Error('No Gerber files found in ZIP archive');
          }
        } else {
          filesToRender = [{ name: file.name, text: new TextDecoder().decode(buffer) }];
        }

        const layerMap = whatsThatGerber(filesToRender.map((f) => f.name));
        const rendered: GerberLayer[] = [];
        const parsedViewBoxes: ViewBox[] = [];

        for (const entry of filesToRender) {
          if (cancelled) return;
          try {
            const svg = await renderGerberToSvg(entry.text, entry.name);
            const info = (layerMap[entry.name] as LayerInfo | undefined) ?? null;
            const layerTone = getLayerTone(info, entry.name);
            const layerColor = getLayerColor(info, entry.name);
            const parsedViewBox = parseViewBox(svg);
            if (parsedViewBox) {
              parsedViewBoxes.push(parsedViewBox);
            }
            rendered.push({
              name: entry.name,
              svg,
              info,
              color: layerColor,
              tone: layerTone,
              visible: true,
            });
          } catch {
            // Skip files that fail to render
          }
        }

        if (cancelled) return;
        if (rendered.length === 0) {
          throw new Error('No Gerber layers could be rendered');
        }

        const mergedViewBox = mergeViewBoxes(parsedViewBoxes);
        const normalizedLayers = rendered.map((layer) => ({
          ...layer,
          svg: normalizeLayerSvg(layer.svg, layer.color, mergedViewBox),
        }));

        setLayers(normalizedLayers);
        setLoading(false);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to render Gerber file');
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file.name, file.url, file.type]);

  const toggleLayer = (index: number) => {
    setLayers((prev) =>
      prev.map((layer, i) => (i === index ? { ...layer, visible: !layer.visible } : layer))
    );
  };

  const setAllLayersVisible = (visible: boolean) => {
    setLayers((prev) => prev.map((layer) => ({ ...layer, visible })));
  };

  if (loading) {
    return (
      <div className="gerber-viewer-loading">
        <div className="spinner"></div>
        <p>Rendering Gerber{file.type === 'gerber_zip' ? ' layers' : ''}...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="gerber-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  const visibleLayers = layers.filter((l) => l.visible);
  const selectedCount = visibleLayers.length;

  return (
    <div className="gerber-viewer">
      <div className="gerber-toolbar">
        <div className="gerber-toolbar-meta">
          <span className="gerber-toolbar-title">{file.name}</span>
          <span className="gerber-toolbar-detail">{selectedCount}/{layers.length} visible</span>
        </div>
        <div className="gerber-toolbar-actions">
          <button type="button" onClick={() => setAllLayersVisible(true)}>Show all</button>
          <button type="button" onClick={() => setAllLayersVisible(false)}>Hide all</button>
          {layers.length > 1 && (
            <button type="button" onClick={() => setShowLayerPanel((value) => !value)}>
              {showLayerPanel ? 'Hide list' : 'Show list'}
            </button>
          )}
        </div>
      </div>

      <div className="gerber-workspace">
        {showLayerPanel && layers.length > 1 && (
          <aside className="gerber-layer-panel" aria-label="Gerber layers">
            {layers.map((layer, i) => (
              <button
                key={layer.name}
                type="button"
                className={`gerber-layer-chip tone-${layer.tone} ${layer.visible ? 'is-visible' : 'is-hidden'}`}
                onClick={() => toggleLayer(i)}
                title={layer.info ? formatLayerInfo(layer.info) : layer.name}
              >
                <span className="gerber-layer-swatch" />
                <span className="gerber-layer-label">{layer.info ? formatLayerInfo(layer.info) : layer.name}</span>
                <span className="gerber-layer-file">{layer.name}</span>
              </button>
            ))}
          </aside>
        )}

        <div className="gerber-canvas-wrap">
          <div className="gerber-canvas-grid" />
          <div className="gerber-canvas">
            {visibleLayers.map((layer) => (
              <div
                key={layer.name}
                className={`gerber-layer-svg tone-${layer.tone} ${layer.tone === 'mask' ? 'is-mask' : ''}`}
                dangerouslySetInnerHTML={{ __html: layer.svg }}
              />
            ))}
            {visibleLayers.length === 0 && (
              <div className="gerber-empty-selection">
                <p>No layers selected. Enable one or more layers from the list.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
