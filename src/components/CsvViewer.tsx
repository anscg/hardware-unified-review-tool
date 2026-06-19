import { useEffect, useState } from 'react';
import Papa from 'papaparse';
import type { CsvFileData } from '../store/useStore';
import { fetchFileContent } from '../utils/github';

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

export default function CsvViewer({ file }: { file: CsvFileData }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setHeader([]);
    setRows([]);

    const load = async () => {
      try {
        const buffer = await fetchFileContent(file.url, undefined, controller.signal);
        if (cancelled) return;

        const text = new TextDecoder().decode(buffer);
        const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
        if (result.errors.length > 0 && result.data.length === 0) {
          throw new Error(result.errors[0].message);
        }

        const [first, ...rest] = result.data;
        setHeader(first ?? []);
        setRows(rest);
        setLoading(false);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load CSV file');
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file.url]);

  if (loading) {
    return (
      <div className="csv-viewer-loading">
        <div className="spinner"></div>
        <p>Loading {file.name}...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="csv-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="csv-viewer">
      <div className="csv-viewer-toolbar">
        <span className="csv-viewer-title">{file.name}</span>
        <span className="csv-viewer-detail">{rows.length} rows</span>
      </div>
      <div className="csv-viewer-body">
        <table className="csv-table">
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th key={i}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    {isUrl(cell) ? (
                      <a href={cell} target="_blank" rel="noopener noreferrer">
                        {cell}
                      </a>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
