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

        // BFS from the selected schematic: only fetch sub-sheets it references
        // (via Sheetfile properties), not parent or sibling files. Including
        // parent schematics causes KiCanvas to root the project at the true
        // project root rather than the selected file, making every schematic
        // appear identical.
        const rootPath = findRootPath(resolverMap, fileUrl) ?? filePath;
        const rootDirEnd = rootPath.lastIndexOf('/');
        const rootDir = rootDirEnd >= 0 ? rootPath.slice(0, rootDirEnd + 1) : '';

        // fetchedSources keys: full repo-relative path AND bare basename.
        // Full paths let KiCanvas build the sheet hierarchy; basenames let it
        // resolve Sheetfile references (which are always bare filenames).
        const fetchedSources = new Map<string, string>();
        fetchedSources.set(rootPath, rootText);
        if (rootDirEnd >= 0) fetchedSources.set(rootPath.slice(rootDirEnd + 1), rootText);

        // Iterative BFS so each depth level is fetched in parallel.
        const pending = new Set<string>(extractSheetfiles(rootText));
        const seen = new Set<string>(pending);
        while (pending.size > 0) {
          const level = [...pending];
          pending.clear();
          await Promise.all(level.map(async (sheetfile) => {
            const url = resolverMap.get(rootDir + sheetfile) ?? resolverMap.get(sheetfile);
            if (!url) return;
            try {
              const buf = await fetchFileContent(url);
              const text = new TextDecoder().decode(buf);
              fetchedSources.set(rootDir + sheetfile, text);
              fetchedSources.set(sheetfile, text);
              for (const sf of extractSheetfiles(text)) {
                if (!seen.has(sf)) { seen.add(sf); pending.add(sf); }
              }
            } catch (e) {
              console.warn(`Failed to prefetch KiCad sub-sheet ${sheetfile}:`, e);
            }
          }));
        }

        // Include any .kicad_pro project file in the same directory.
        for (const [key, url] of resolverMap) {
          if (!key.endsWith('.kicad_pro') || fetchedSources.has(key)) continue;
          if (!key.includes('/') && findPathForBasename(resolverMap, key)) continue;
          const inSameDir = rootDir
            ? key.startsWith(rootDir) && !key.slice(rootDir.length).includes('/')
            : !key.includes('/');
          if (!inSameDir) continue;
          try {
            const buf = await fetchFileContent(url);
            fetchedSources.set(key, new TextDecoder().decode(buf));
          } catch (e) {
            console.warn(`Failed to prefetch KiCad project file ${key}:`, e);
          }
        }

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

        const appendSource = (name: string, text: string) => {
          const source = document.createElement('kicanvas-source');
          source.setAttribute('name', name);
          source.textContent = text;
          embed.appendChild(source);
        };

        // fetchedSources already contains both full-path and bare-basename
        // entries for every file (set during BFS above), so iterating it
        // once gives KiCanvas everything it needs.
        const appended = new Set<string>();
        for (const [name, text] of fetchedSources) {
          if (!appended.has(name)) {
            appendSource(name, text);
            appended.add(name);
          }
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

// Returns all Sheetfile values referenced in a KiCad schematic string.
function extractSheetfiles(kicadSchText: string): string[] {
  const results: string[] = [];
  for (const m of kicadSchText.matchAll(/\(property\s+"Sheetfile"\s+"([^"]+)"/g)) {
    results.push(m[1]);
  }
  return results;
}

// Prefer the full repo-relative path entry over the bare-basename entry in
// the resolver map so KiCanvas gets a stable page identifier.
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
