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
        // Project.load() looks those up in its inline VFS by that exact
        // (basename) string, so we register inline sources by basename.
        //
        // We only inline sheets that are *descendants* of the user-selected
        // root. If we preload every sibling schematic in the directory,
        // KiCanvas's hierarchy walk identifies the topmost ancestor as the
        // root and the embed jumps there on load — making every file in the
        // project look identical to its top-level parent.
        const rootSourceName = fileName;
        const fetchedSources = new Map<string, string>();
        fetchedSources.set(rootSourceName, rootText);

        const visit = async (text: string) => {
          const refs = extractSheetfileRefs(text);
          const tasks: Promise<void>[] = [];
          for (const ref of refs) {
            if (fetchedSources.has(ref)) continue;
            const url = resolverMap.get(ref);
            if (!url) {
              console.warn(`KiCad subsheet ${ref} not found in repository`);
              continue;
            }
            // Mark before await to avoid duplicate fetches across parallel tasks.
            fetchedSources.set(ref, '');
            tasks.push(
              (async () => {
                try {
                  const buf = await fetchFileContent(url);
                  const subText = new TextDecoder().decode(buf);
                  fetchedSources.set(ref, subText);
                  await visit(subText);
                } catch (e) {
                  fetchedSources.delete(ref);
                  console.warn(`Failed to prefetch subsheet ${ref}:`, e);
                }
              })()
            );
          }
          await Promise.all(tasks);
        };
        await visit(rootText);

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
        appendSource(rootSourceName, rootText);
        for (const [name, text] of fetchedSources) {
          if (name === rootSourceName) continue;
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
  }, [ready, fileUrl, filePath, fileName]);

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

// Extract the basenames referenced as subsheets from a KiCad schematic.
// Matches forms like:
//   (property "Sheetfile" "main_mcu.kicad_sch" ...)
//   (sheetfile "main_mcu.kicad_sch")
function extractSheetfileRefs(schText: string): string[] {
  const refs = new Set<string>();
  const propRe = /\(property\s+"Sheetfile"\s+"([^"]+\.kicad_sch)"/gi;
  const bareRe = /\(sheetfile\s+"([^"]+\.kicad_sch)"/gi;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(schText))) refs.add(m[1]!);
  while ((m = bareRe.exec(schText))) refs.add(m[1]!);
  return Array.from(refs);
}
