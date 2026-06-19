import { useEffect, useState } from 'react';
import type { PdfFileData } from '../store/useStore';
import { fetchFileContent } from '../utils/github';

export default function PdfViewer({ file }: { file: PdfFileData }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setBlobUrl(null);

    const load = async () => {
      try {
        const buffer = await fetchFileContent(file.url, undefined, controller.signal);
        if (cancelled) return;

        // raw.githubusercontent.com serves PDFs as application/octet-stream with
        // X-Frame-Options: deny, so an <iframe src> pointed straight at it either gets
        // blocked or triggers a download instead of rendering inline. Fetching the bytes
        // ourselves and handing the iframe a blob: URL (explicitly typed as application/pdf)
        // sidesteps both restrictions.
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
        setBlobUrl(objectUrl);
        setLoading(false);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load PDF file');
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url]);

  if (loading) {
    return (
      <div className="pdf-viewer-loading">
        <div className="spinner"></div>
        <p>Loading {file.name}...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pdf-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <iframe className="pdf-viewer-frame" src={blobUrl ?? undefined} title={file.name} />
    </div>
  );
}
