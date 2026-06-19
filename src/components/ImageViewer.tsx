import { useEffect, useState } from 'react';
import type { ImageFileData } from '../store/useStore';
import { fetchFileContent } from '../utils/github';

export default function ImageViewer({ file }: { file: ImageFileData }) {
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
        // Fetch ourselves (rather than a direct <img src>) so Git LFS pointer files
        // resolve to the real image bytes instead of rendering as a broken image.
        const buffer = await fetchFileContent(file.url, undefined, controller.signal);
        if (cancelled) return;

        objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'image/png' }));
        setBlobUrl(objectUrl);
        setLoading(false);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load image');
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
      <div className="image-viewer-loading">
        <div className="spinner"></div>
        <p>Loading {file.name}...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="image-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="image-viewer">
      <div className="image-viewer-toolbar">
        <span className="image-viewer-title">{file.name}</span>
      </div>
      <div className="image-viewer-body">
        <img src={blobUrl ?? undefined} alt={file.name} />
      </div>
    </div>
  );
}
