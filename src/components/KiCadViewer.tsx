import { useEffect, useRef, useState } from 'react';
import { ensureKiCanvasLoaded } from '../integrations/kicanvasLoader';
import { fetchFileContent } from '../utils/github';

interface KiCadViewerProps {
  fileUrl: string;
  fileName: string;
  resolverMap: Map<string, string>;
}

export default function KiCadViewer({ fileUrl, fileName, resolverMap }: KiCadViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const embedRef = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ensureKiCanvasLoaded()
      .then(() => setReady(true))
      .catch((err) => setError(`Failed to load KiCad viewer: ${err.message}`));
  }, []);

  useEffect(() => {
    if (!ready || !containerRef.current) return;

    let cancelled = false;

    async function loadFile() {
      setLoading(true);
      setError(null);

      try {
        // Pre-fetch the root file ourselves to avoid CORS / LFS issues.
        const rootBuffer = await fetchFileContent(fileUrl);
        const rootText = new TextDecoder().decode(rootBuffer);

        if (cancelled) return;

        // Hierarchical KiCad schematics reference subsheets by relative
        // filename (e.g. (property "Sheetfile" "usb.kicad_sch")). KiCanvas's
        // inline filesystem only contains the files we explicitly provide;
        // its `custom_resolver` is consulted only for URL-based sources, not
        // for inline ones. So we must prefetch every related .kicad_sch /
        // .kicad_pro in the same directory and inline them all.
        const rootPath = findRootPath(resolverMap, fileUrl);
        const dirPrefix = rootPath ? rootPath.replace(/[^/]*$/, '') : '';

        const relatedExt = /\.(kicad_sch|kicad_pro)$/i;
        const relatedFiles = new Map<string, string>(); // basename -> rawUrl
        for (const [key, url] of resolverMap) {
          if (key.includes('/')) continue; // we already index basename + path; basename keys suffice
          if (!relatedExt.test(key)) continue;
          // Restrict to the same directory as the root file when known.
          const path = findPathForBasename(resolverMap, key);
          if (dirPrefix && path && !path.startsWith(dirPrefix)) continue;
          relatedFiles.set(key, url);
        }
        // Always include the root file itself.
        relatedFiles.set(fileName, fileUrl);

        // Fetch all related files in parallel. The root one is already loaded.
        const fetchedSources = new Map<string, string>();
        fetchedSources.set(fileName, rootText);
        const fetchTasks: Promise<void>[] = [];
        for (const [name, url] of relatedFiles) {
          if (fetchedSources.has(name)) continue;
          fetchTasks.push(
            (async () => {
              try {
                const buf = await fetchFileContent(url);
                fetchedSources.set(name, new TextDecoder().decode(buf));
              } catch (e) {
                // A missing/failed subsheet shouldn't block the whole render;
                // KiCanvas will warn for any sheet it can't resolve.
                console.warn(`Failed to prefetch related KiCad file ${name}:`, e);
              }
            })()
          );
        }
        await Promise.all(fetchTasks);

        if (cancelled) return;

        // Remove previous embed
        if (embedRef.current) {
          embedRef.current.remove();
          embedRef.current = null;
        }

        // Build a kicanvas-embed with inline sources for every related file.
        const embed = document.createElement('kicanvas-embed');
        embed.setAttribute('controls', 'full');
        embed.setAttribute('controlslist', 'nooverlay');
        embed.style.width = '100%';
        embed.style.height = '100%';

        // Resolver fallback (used by URL-based sources, which we don't use,
        // but harmless to set for any KiCanvas internal lookups).
        (embed as any).custom_resolver = (name: string) => {
          const url = resolverMap.get(name) ?? resolverMap.get(name.split('/').pop()!);
          return url ? new URL(url) : new URL(fileUrl);
        };

        // Add the root first so KiCanvas treats it as the entry point, then
        // add each subsheet/project file.
        const appendSource = (name: string, text: string) => {
          const source = document.createElement('kicanvas-source');
          source.setAttribute('name', name);
          source.textContent = text;
          embed.appendChild(source);
        };
        appendSource(fileName, rootText);
        for (const [name, text] of fetchedSources) {
          if (name === fileName) continue;
          appendSource(name, text);
        }

        containerRef.current!.appendChild(embed);
        embedRef.current = embed;
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load file');
          setLoading(false);
        }
      }
    }

    loadFile();

    return () => {
      cancelled = true;
      if (embedRef.current) {
        embedRef.current.remove();
        embedRef.current = null;
      }
    };
  }, [ready, fileUrl, fileName, resolverMap]);

  if (error) {
    return (
      <div className="kicad-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="kicad-viewer">
      {(!ready || loading) && (
        <div className="kicad-viewer-loading">
          <div className="spinner"></div>
          <p>Loading KiCad viewer…</p>
        </div>
      )}
    </div>
  );
}

// The resolver map (built in fetchRepositoryFiles) contains entries keyed
// by both full repo path (e.g. "pcb/hackxpansion.kicad_sch") and basename
// (e.g. "hackxpansion.kicad_sch"), both pointing at the raw URL. To find the
// directory of the root file we need to recover its full path.
function findRootPath(
  resolverMap: Map<string, string>,
  rootUrl: string
): string | null {
  for (const [key, url] of resolverMap) {
    if (url === rootUrl && key.includes('/')) return key;
  }
  return null;
}

function findPathForBasename(
  resolverMap: Map<string, string>,
  basename: string
): string | null {
  const url = resolverMap.get(basename);
  if (!url) return null;
  for (const [key, candidate] of resolverMap) {
    if (candidate === url && key.includes('/') && key.endsWith('/' + basename)) {
      return key;
    }
  }
  return null;
}
