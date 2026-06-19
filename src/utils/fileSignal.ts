import type { HardwareFile } from '../store/useStore';

// The "important stuff" for a quick skim: the readme, any PDFs (datasheets/manuals),
// every loadable CAD/PCB/Gerber/3D-model file, and BOM-style .csv files. Drives the Pinned
// view, which folders auto-expand in the Full view, and which file opens by default on load.
export function isSignalFile(file: HardwareFile): boolean {
  if (file.kind === 'pdf' || file.kind === 'csv') return true;
  if (file.kind === 'kicad' || file.kind === 'gerber' || file.kind === 'model') return true;
  // easyeda_json and easyeda_zip are catch-alls (any .json or non-gerber-looking .zip in the
  // repo gets tagged 'easyeda'), not a real signal of an EasyEDA project -- e.g. they also
  // catch package.json/tsconfig.json and unrelated zip archives like KiCad project backups.
  // The other EasyEDA export types (.epro, .eproproject, .esch, .epcb) are unambiguous.
  if (file.kind === 'easyeda') return file.type !== 'easyeda_json' && file.type !== 'easyeda_zip';
  if (file.kind === 'markdown') return /^readme(\.|$)/i.test(file.name);
  return false;
}

const PINNED_KIND_ORDER: Record<string, number> = {
  markdown: 0,
  pdf: 1,
  kicad: 2,
  easyeda: 2,
  gerber: 2,
  model: 2,
  csv: 3 // BOM files: still pinned, but sorted to the end of the list
};

export function getPinnedFiles(files: HardwareFile[]): HardwareFile[] {
  return files
    .filter(isSignalFile)
    .sort((a, b) => {
      const orderA = PINNED_KIND_ORDER[a.kind] ?? 9;
      const orderB = PINNED_KIND_ORDER[b.kind] ?? 9;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
}
