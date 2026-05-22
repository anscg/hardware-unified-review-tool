import { useEffect, useRef, useState } from 'react';
import { ensureKiCanvasLoaded } from '../integrations/kicanvasLoader';
import { fetchFileContent } from '../utils/github';

interface KiCadViewerProps {
  fileUrl: string;
  filePath: string;
  fileName: string;
  resolverMap: Map<string, string>;
}

export default function KiCadViewer({ fileUrl, filePath, fileName, resolverMap }: KiCadViewerProps) {
  // mountRef is owned imperatively by us. React MUST NOT render any children
  // into it, otherwise reconciliation can wipe out the <kicanvas-embed> we
  // append, which causes the viewer to re-create itself and reset back to the
  // root schematic page on every store-induced re-render.
  const mountRef = useRef<HTMLDivElement>(null);
  const embedRef = useRef<HTMLElement | null>(null);
  // Hold the latest resolverMap in a ref so the effect doesn't re-run (and
  // tear down the embed) just because zustand handed back a fresh object.
  const resolverMapRef = useRef(resolverMap);
  resolverMapRef.current = resolverMap;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ensureKiCanvasLoaded()
      .then(() => setReady(true))
      .catch((err) => setError(`Failed to load KiCad viewer: ${err.message}`));
  }, []);

  useEffect(() => {
    if (!ready || !mountRef.current) return;

    const resolverMap = resolverMapRef.current;
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
        const rootPath = findRootPath(resolverMap, fileUrl) ?? filePath;

        const relatedExt = /\.(kicad_sch|kicad_pro)$/i;
        const relatedFiles = new Map<string, string>(); // repo-relative path -> rawUrl
        for (const [key, url] of resolverMap) {
          if (!relatedExt.test(key)) continue;
          // Prefer repo-relative paths. KiCanvas stores page identifiers using
          // the exact sheetfile strings from the schematic, so collapsing to a
          // basename makes sheet navigation fall back to the root page.
          if (!key.includes('/') && findPathForBasename(resolverMap, key)) continue;
          if (rootPath && key === fileName) {
            relatedFiles.set(rootPath, url);
            continue;
          }
          relatedFiles.set(key, url);
        }
        // Always include the root file itself.
        relatedFiles.set(rootPath ?? filePath, fileUrl);

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
        appendSource(rootPath ?? filePath, rootText);
        for (const [name, text] of fetchedSources) {
          if (name === (rootPath ?? filePath)) continue;
          appendSource(name, text);
        }

        mountRef.current!.appendChild(embed);
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
        // Intentionally NOT depending on resolverMap: it's read via a ref so a new
        // Map instance from zustand doesn't tear down and rebuild the embed (which
        // would reset the active schematic page back to root every time).
  }, [ready, fileUrl, fileName]);

  if (error) {
    return (
      <div className="kicad-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="kicad-viewer">
      {/* React-managed loading overlay – kept as a SIBLING of the mount node
          so React's reconciliation never touches the embed's parent. */}
      {(!ready || loading) && (
        <div className="kicad-viewer-loading">
          <div className="spinner"></div>
          <p>Loading KiCad viewer…</p>
        </div>
      )}
      {/* Imperative mount point for <kicanvas-embed>. React must never render
          children into this node. */}
      <div ref={mountRef} className="kicad-viewer-mount" />
    </div>
  );
}

// The resolver map (built in fetchRepositoryFiles) contains entries keyed
// by both full repo path (e.g. "pcb/hackxpansion.kicad_sch") and basename
// (e.g. "hackxpansion.kicad_sch"), both pointing at the raw URL. The full
// repo-relative path is the stable identifier KiCanvas needs for sheet
// navigation, so we prefer it whenever we can recover it.
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
