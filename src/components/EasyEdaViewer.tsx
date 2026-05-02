import { useEffect, useMemo, useState } from 'react';
import type { EasyEdaFileData } from '../store/useStore';
import { fetchFileContent } from '../utils/github';
import {
  analyzeEasyEdaJson,
  extractPrimaryEasyEdaArchiveJsonDocument,
  inspectEasyEdaArchive,
  tryParseJsonContent,
  type EasyEdaArchiveInspection,
  type EasyEdaDocumentKind,
  type EasyEdaJsonInspection,
} from '../utils/easyeda';
import { buildEasyEdaVisualDocument, type EasyEdaVisualDocument } from '../utils/easyedaVisual';
import {
  buildEasyEdaProPcbVisual,
  buildEasyEdaProSchematicVisual,
  extractEasyEdaProArchive,
  parseProDocument,
  type ProArchive,
  type ProDocument,
} from '../utils/easyedaPro';
import EasyEdaCanvasView from './EasyEdaCanvasView';

interface ProSheetSelector {
  id: string;
  label: string;
  documentKind: EasyEdaDocumentKind;
  build: () => EasyEdaVisualDocument | null;
}

type EasyEdaReadResult =
  | {
      mode: 'json';
      sourceLabel: string;
      sourceEntry: string | null;
      inspection: EasyEdaJsonInspection;
      visualDocument: EasyEdaVisualDocument | null;
      preview: string;
      truncated: boolean;
    }
  | {
      mode: 'pro';
      sourceLabel: string;
      sheets: ProSheetSelector[];
      defaultIndex: number;
      summary: ProSummary;
    }
  | {
      mode: 'archive';
      archiveFormat: 'EPRO' | 'ZIP' | 'EPROJECT';
      inspection: EasyEdaArchiveInspection;
    };

interface ProSummary {
  pcbCount: number;
  sheetCount: number;
  footprintCount: number;
  symbolCount: number;
}

type EasyEdaViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: EasyEdaReadResult };

const JSON_PREVIEW_LIMIT = 18000;
const ARCHIVE_ENTRY_PREVIEW_LIMIT = 140;

export default function EasyEdaViewer({ file }: { file: EasyEdaFileData }) {
  const [state, setState] = useState<EasyEdaViewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    setState({ status: 'loading' });

    const readFile = async () => {
      try {
        const content = await fetchFileContent(file.url, undefined, controller.signal);
        if (cancelled) return;

        const archiveFormat: 'EPRO' | 'ZIP' | 'EPROJECT' =
          file.type === 'easyeda_eproproject'
            ? 'EPROJECT'
            : file.type === 'easyeda_epro'
              ? 'EPRO'
              : 'ZIP';

        // EasyEDA Pro projects: .epro / .eproproject ZIP archives that contain
        // line-delimited NDJSON .epcb/.esch files plus footprints/symbols.
        if (file.type === 'easyeda_epro' || file.type === 'easyeda_eproproject') {
          try {
            const proResult = await tryBuildProArchiveResult(content, file.name, archiveFormat);
            if (cancelled) return;
            if (proResult) {
              setState({ status: 'ready', result: proResult });
              return;
            }
          } catch {
            // fall through to legacy JSON / inspection path
          }
        }

        const parsedJson = tryParseJsonContent(content);

        const isDirectJson =
          file.type === 'easyeda_json' ||
          file.type === 'easyeda_esch' ||
          file.type === 'easyeda_epcb';

        if (isDirectJson) {
          // Pro .esch/.epcb are NDJSON line-arrays, not single JSON values.
          if (!parsedJson && (file.type === 'easyeda_esch' || file.type === 'easyeda_epcb')) {
            const text = new TextDecoder().decode(content);
            const proDoc = parseProDocument(text);
            if (proDoc) {
              const proResult = buildProDocumentResult(proDoc, file.name, file.type);
              setState({ status: 'ready', result: proResult });
              return;
            }
          }
          if (!parsedJson) {
            throw new Error(
              `File ${file.name} is expected to be a JSON document but content is not valid JSON.`
            );
          }
          const sourceLabel =
            file.type === 'easyeda_esch'
              ? 'ESCH (EasyEDA Pro schematic)'
              : file.type === 'easyeda_epcb'
                ? 'EPCB (EasyEDA Pro PCB)'
                : 'JSON';
          setState({
            status: 'ready',
            result: buildJsonResult(parsedJson.value, file.name, sourceLabel, parsedJson.text),
          });
          return;
        }

        // Some .epro files are plain JSON rather than ZIP archives.
        if (parsedJson) {
          setState({
            status: 'ready',
            result: buildJsonResult(
              parsedJson.value,
              file.name,
              archiveFormat,
              parsedJson.text
            ),
          });
          return;
        }

        const archiveDocument = await extractPrimaryEasyEdaArchiveJsonDocument(content);
        if (cancelled) return;

        if (archiveDocument) {
          setState({
            status: 'ready',
            result: buildJsonResult(
              archiveDocument.value,
              archiveDocument.name,
              `${archiveFormat} archive`,
              archiveDocument.text,
              archiveDocument.name
            ),
          });
          return;
        }

        const archiveInspection = await inspectEasyEdaArchive(content);
        if (cancelled) return;

        setState({
          status: 'ready',
          result: {
            mode: 'archive',
            archiveFormat,
            inspection: archiveInspection,
          },
        });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to read EasyEDA file',
        });
      }
    };

    void readFile();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file.name, file.type, file.url]);

  if (state.status === 'loading') {
    return (
      <div className="easyeda-viewer-loading">
        <div className="spinner"></div>
        <p>Reading EasyEDA file...</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="easyeda-viewer-error">
        <div className="error-icon">!</div>
        <p>{state.message}</p>
      </div>
    );
  }

  const result = state.result;

  if (result.mode === 'pro') {
    return <EasyEdaProView file={file} result={result} />;
  }

  if (result.mode === 'json') {
    const isPcb = result.inspection.documentKind === 'pcb';
    const hasVisual = Boolean(result.visualDocument);

    // PCB with visual: immersive full-screen canvas like KiCad viewer
    if (isPcb && result.visualDocument) {
      return (
        <div className="easyeda-viewer easyeda-pcb-fullscreen">
          <EasyEdaCanvasView document={result.visualDocument} />
        </div>
      );
    }

    return (
      <div className={`easyeda-viewer ${hasVisual ? 'easyeda-visual' : 'easyeda-archive'}`}>
        <div className="easyeda-summary">
          <h3>{file.name}</h3>
          <p>
            Source: <strong>{result.sourceLabel}</strong>
            {result.sourceEntry && (
              <>
                {' '}
                | Entry: <strong>{result.sourceEntry}</strong>
              </>
            )}{' '}
            | File type:{' '}
            <strong>
              {documentKindIcon(result.inspection.documentKind)}{' '}
              {formatDocumentKind(result.inspection.documentKind)}
            </strong>
          </p>
          <p>
            EasyEDA signature:{' '}
            <strong>{result.inspection.isEasyEda ? 'Likely' : 'Not detected'}</strong>
          </p>
          {result.visualDocument && (
            <p>
              Rendered primitives: <strong>{result.visualDocument.primitives.length}</strong> (from{' '}
              <strong>{result.visualDocument.shapeCount}</strong> shape rows)
            </p>
          )}
          {result.visualDocument && result.visualDocument.unknownShapePrefixes.length > 0 && (
            <p className="easyeda-muted">
              Unhandled shape types:{' '}
              {result.visualDocument.unknownShapePrefixes.slice(0, 8).join(', ')}
              {result.visualDocument.unknownShapePrefixes.length > 8 ? ', ...' : ''}
            </p>
          )}
          {result.inspection.topLevelKeys.length > 0 && (
            <p className="easyeda-muted">
              Top-level keys: {result.inspection.topLevelKeys.slice(0, 18).join(', ')}
            </p>
          )}
        </div>
        {result.visualDocument ? (
          <>
            <EasyEdaCanvasView document={result.visualDocument} />
            <details className="easyeda-json-details">
              <summary>Raw JSON</summary>
              <pre className="easyeda-json-preview">{result.preview}</pre>
            </details>
          </>
        ) : (
          <>
            <pre className="easyeda-json-preview">{result.preview}</pre>
            {result.truncated && (
              <p className="easyeda-muted">
                JSON preview truncated to {JSON_PREVIEW_LIMIT.toLocaleString()} characters.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  const entries = result.inspection.entries;
  const detectedDocs = entries.filter((entry) => entry.isEasyEdaJson);
  const displayedEntries = entries.slice(0, ARCHIVE_ENTRY_PREVIEW_LIMIT);

  return (
    <div className="easyeda-viewer easyeda-archive">
      <div className="easyeda-summary">
        <h3>{file.name}</h3>
        <p>
          Source: <strong>{result.archiveFormat}</strong> archive | Entries:{' '}
          <strong>{entries.length}</strong>
        </p>
        <p>
          Detected EasyEDA docs: <strong>{detectedDocs.length}</strong>
        </p>
        {result.inspection.skippedJsonEntries > 0 && (
          <p className="easyeda-muted">
            Skipped JSON inspection for {result.inspection.skippedJsonEntries} archive entries
            (size/compression limits).
          </p>
        )}
        {result.inspection.unsupportedEntries > 0 && (
          <p className="easyeda-muted">
            {result.inspection.unsupportedEntries} entries use unsupported compression.
          </p>
        )}
      </div>

      <div className="easyeda-entry-list">
        {displayedEntries.map((entry, index) => (
          <div className="easyeda-entry-row" key={`${entry.name}-${index}`}>
            <span className="easyeda-entry-name">{entry.name}</span>
            <span className="easyeda-entry-kind">
              {entry.easyEdaDocumentKind
                ? `${documentKindIcon(entry.easyEdaDocumentKind)} ${formatDocumentKind(entry.easyEdaDocumentKind)}`
                : entry.isEasyEdaJson
                  ? 'JSON'
                  : 'File'}
            </span>
            <span className="easyeda-entry-size">{formatBytes(entry.size)}</span>
          </div>
        ))}
      </div>

      {entries.length > displayedEntries.length && (
        <p className="easyeda-muted">
          Showing first {ARCHIVE_ENTRY_PREVIEW_LIMIT} of {entries.length} entries.
        </p>
      )}
    </div>
  );
}

function buildJsonResult(
  value: unknown,
  filename: string,
  sourceLabel: string,
  sourceText?: string,
  sourceEntry: string | null = null
): EasyEdaReadResult {
  const inspection = analyzeEasyEdaJson(value, filename);
  const previewSource = sourceText ?? JSON.stringify(value, null, 2);
  const truncated = previewSource.length > JSON_PREVIEW_LIMIT;
  const preview = truncated
    ? `${previewSource.slice(0, JSON_PREVIEW_LIMIT)}\n...`
    : previewSource;
  const visualDocument = buildEasyEdaVisualDocument(value, filename, inspection.documentKind);

  return {
    mode: 'json',
    sourceLabel,
    sourceEntry,
    inspection,
    visualDocument,
    preview,
    truncated,
  };
}

function formatDocumentKind(kind: EasyEdaDocumentKind): string {
  switch (kind) {
    case 'schematic':
      return 'Schematic';
    case 'pcb':
      return 'PCB';
    case 'library':
      return 'Library';
    case 'project':
      return 'Project';
    default:
      return 'Unknown';
  }
}

function documentKindIcon(kind: EasyEdaDocumentKind): string {
  switch (kind) {
    case 'schematic':
      return '📐';
    case 'pcb':
      return '🟩';
    case 'library':
      return '📦';
    case 'project':
      return '📁';
    default:
      return '📄';
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function tryBuildProArchiveResult(
  content: ArrayBuffer,
  filename: string,
  archiveFormat: 'EPRO' | 'ZIP' | 'EPROJECT'
): Promise<EasyEdaReadResult | null> {
  const archive = await extractEasyEdaProArchive(content);
  const sheets = collectProSheets(archive);
  if (sheets.length === 0) {
    return null;
  }

  // Default to first PCB if any, otherwise first sheet.
  let defaultIndex = sheets.findIndex((s) => s.documentKind === 'pcb');
  if (defaultIndex < 0) defaultIndex = 0;

  return {
    mode: 'pro',
    sourceLabel: `${archiveFormat} archive (${filename})`,
    sheets,
    defaultIndex,
    summary: {
      pcbCount: archive.pcbs.size,
      sheetCount: archive.schematicSheets.size,
      footprintCount: archive.footprints.size,
      symbolCount: archive.symbols.size,
    },
  };
}

function collectProSheets(archive: ProArchive): ProSheetSelector[] {
  const sheets: ProSheetSelector[] = [];

  // PCBs
  for (const [id, doc] of archive.pcbs) {
    const matchedName = archive.projectInfo?.pcbs.find((entry) => entry.uuid === id)?.name ?? id;
    const label = `PCB · ${matchedName}`;
    sheets.push({
      id: `pcb:${id}`,
      label,
      documentKind: 'pcb',
      build: () => buildEasyEdaProPcbVisual(archive, doc, label),
    });
  }

  // Schematic sheets ordered by project info if available.
  const orderedSheetKeys: string[] = [];
  if (archive.projectInfo) {
    for (const sch of archive.projectInfo.schematics) {
      for (const sheet of sch.sheets) {
        const key = `${sch.uuid}/${sheet.id}`;
        if (archive.schematicSheets.has(key)) {
          orderedSheetKeys.push(key);
        }
      }
    }
  }
  for (const key of archive.schematicSheets.keys()) {
    if (!orderedSheetKeys.includes(key)) orderedSheetKeys.push(key);
  }

  for (const key of orderedSheetKeys) {
    const doc = archive.schematicSheets.get(key);
    if (!doc) continue;
    const sheetInfo = findSheetInfo(archive, key);
    const label = `Schematic · ${sheetInfo?.name ?? key}`;
    sheets.push({
      id: `sch:${key}`,
      label,
      documentKind: 'schematic',
      build: () => buildEasyEdaProSchematicVisual(archive, doc, label),
    });
  }

  return sheets;
}

function findSheetInfo(
  archive: ProArchive,
  key: string
): { name: string; schematic: string } | null {
  if (!archive.projectInfo) return null;
  const [schUuid, sheetId] = key.split('/');
  const sch = archive.projectInfo.schematics.find((s) => s.uuid === schUuid);
  if (!sch) return null;
  const sheet = sch.sheets.find((s) => String(s.id) === sheetId || s.uuid === sheetId);
  if (!sheet) return null;
  return { name: sheet.name, schematic: sch.name };
}

function buildProDocumentResult(
  doc: ProDocument,
  filename: string,
  fileType: EasyEdaFileData['type']
): EasyEdaReadResult {
  // Build a one-sheet "pro" result from a standalone .esch / .epcb file.
  const archive: ProArchive = {
    projectInfo: null,
    pcbs: new Map(),
    schematicSheets: new Map(),
    footprints: new Map(),
    symbols: new Map(),
  };

  const isPcb = fileType === 'easyeda_epcb' || /^pcb$/i.test(doc.docType);
  const sheet: ProSheetSelector = isPcb
    ? {
        id: 'pcb:standalone',
        label: filename,
        documentKind: 'pcb',
        build: () => buildEasyEdaProPcbVisual(archive, doc, filename),
      }
    : {
        id: 'sch:standalone',
        label: filename,
        documentKind: 'schematic',
        build: () => buildEasyEdaProSchematicVisual(archive, doc, filename),
      };

  return {
    mode: 'pro',
    sourceLabel: isPcb
      ? 'EPCB (EasyEDA Pro PCB)'
      : 'ESCH (EasyEDA Pro schematic)',
    sheets: [sheet],
    defaultIndex: 0,
    summary: {
      pcbCount: isPcb ? 1 : 0,
      sheetCount: isPcb ? 0 : 1,
      footprintCount: 0,
      symbolCount: 0,
    },
  };
}

interface EasyEdaProViewProps {
  file: EasyEdaFileData;
  result: Extract<EasyEdaReadResult, { mode: 'pro' }>;
}

function EasyEdaProView({ file, result }: EasyEdaProViewProps) {
  const [selectedIndex, setSelectedIndex] = useState(result.defaultIndex);
  const sheet = result.sheets[selectedIndex] ?? result.sheets[0];

  const document = useMemo(() => sheet.build(), [sheet]);

  return (
    <div className="easyeda-viewer easyeda-pcb-fullscreen">
      <div className="easyeda-summary easyeda-pro-summary">
        <h3>{file.name}</h3>
        <p>
          Source: <strong>{result.sourceLabel}</strong>{' '}
          | PCBs: <strong>{result.summary.pcbCount}</strong>{' '}
          | Sheets: <strong>{result.summary.sheetCount}</strong>{' '}
          | Footprints: <strong>{result.summary.footprintCount}</strong>{' '}
          | Symbols: <strong>{result.summary.symbolCount}</strong>
        </p>
        {result.sheets.length > 1 && (
          <div className="easyeda-pro-sheets">
            {result.sheets.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                className={`easyeda-pro-sheet-btn ${idx === selectedIndex ? 'active' : ''}`}
                onClick={() => setSelectedIndex(idx)}
              >
                {documentKindIcon(s.documentKind)} {s.label}
              </button>
            ))}
          </div>
        )}
        {document && (
          <p className="easyeda-muted">
            Rendered primitives: <strong>{document.primitives.length}</strong> (from{' '}
            <strong>{document.shapeCount}</strong> rows)
            {document.unknownShapePrefixes.length > 0 && (
              <>
                {' · Unhandled: '}
                {document.unknownShapePrefixes.slice(0, 8).join(', ')}
                {document.unknownShapePrefixes.length > 8 ? ', ...' : ''}
              </>
            )}
          </p>
        )}
      </div>
      {document ? (
        <EasyEdaCanvasView document={document} />
      ) : (
        <div className="easyeda-viewer-error">
          <div className="error-icon">!</div>
          <p>This sheet could not be rendered. The format may use unsupported primitives.</p>
        </div>
      )}
    </div>
  );
}

