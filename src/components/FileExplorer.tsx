import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type HardwareFile, type RepoFileEntry } from '../store/useStore';
import { isSignalFile, getPinnedFiles } from '../utils/fileSignal';
import {
  Box, Settings, Gem, Sparkles, Cpu, FolderOpen, Folder, FileText, File,
  ChevronRight, ChevronDown, NotebookText, FileType, FileCode, Pin, ListTree, FolderTree, Image, Table
} from 'lucide-react';

interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

interface FileNode {
  type: 'file';
  name: string;
  path: string;
  size?: number;
  file?: HardwareFile; // present only when this entry is a loadable/supported file
}

type TreeNode = FolderNode | FileNode;

function buildFileTree(entries: RepoFileEntry[], loadableMap: Map<string, HardwareFile>): TreeNode[] {
  const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };
  const folderMap = new Map<string, FolderNode>([['', root]]);

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    parts.pop(); // drop the file name, keep only directory segments

    let currentPath = '';
    let parent = root;

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = { type: 'folder', name: part, path: currentPath, children: [] };
        folderMap.set(currentPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }

    parent.children.push({
      type: 'file',
      name: entry.name,
      path: entry.path,
      size: entry.size,
      file: loadableMap.get(entry.path)
    });
  }

  sortTree(root);
  return root.children;
}

function sortTree(node: FolderNode) {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.type === 'folder') sortTree(child);
  }
}

// Folders with no CAD/PCB/Gerber/PDF/readme anywhere in their subtree start collapsed
// (footprint/symbol libraries, code, misc assets); folders that lead to one stay open.
function computeDefaultCollapsed(nodes: TreeNode[]): Set<string> {
  const collapsed = new Set<string>();

  const visit = (list: TreeNode[]): boolean => {
    let hasSignal = false;
    for (const node of list) {
      if (node.type === 'file') {
        if (node.file && isSignalFile(node.file)) hasSignal = true;
      } else {
        const childHasSignal = visit(node.children);
        if (!childHasSignal) collapsed.add(node.path);
        hasSignal = hasSignal || childHasSignal;
      }
    }
    return hasSignal;
  };

  visit(nodes);
  return collapsed;
}

const INDENT_REM = 1;
const BASE_PADDING_REM = 0.75;

export default function FileExplorer() {
  const { files, allFiles, selectedFile, setSelectedFile } = useStore();
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'full' | 'pinned'>('pinned');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: HardwareFile } | null>(null);
  const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const loadableMap = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const tree = useMemo(() => buildFileTree(allFiles, loadableMap), [allFiles, loadableMap]);

  const pinnedFiles = useMemo(() => getPinnedFiles(files), [files]);

  useEffect(() => {
    setCollapsedFolders(computeDefaultCollapsed(tree));
  }, [tree]);

  // Close the context menu on any outside click or Escape press.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  // Scroll the revealed row into view and flash it once the Full tree has rendered it.
  useEffect(() => {
    if (!revealRequest) return;
    const el = rowRefs.current.get(revealRequest.path);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timeout = setTimeout(() => setRevealRequest(null), 1500);
    return () => clearTimeout(timeout);
  }, [revealRequest]);

  if (allFiles.length === 0) {
    return null;
  }

  const toggleFolder = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const revealInFullTree = (file: HardwareFile) => {
    const parts = file.path.split('/').filter(Boolean);
    parts.pop();

    let cumulative = '';
    const ancestors: string[] = [];
    for (const part of parts) {
      cumulative = cumulative ? `${cumulative}/${part}` : part;
      ancestors.push(cumulative);
    }

    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      ancestors.forEach((path) => next.delete(path));
      return next;
    });
    setSelectedFile(file);
    setViewMode('full');
    setRevealRequest({ path: file.path, nonce: Date.now() });
    setContextMenu(null);
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (file: HardwareFile) => {
    if (file.kind === 'code') {
      return <FileCode size={18} />;
    }
    if (file.kind === 'image') {
      return <Image size={18} />;
    }
    if (file.kind === 'csv') {
      return <Table size={18} />;
    }
    const iconMap: Record<string, any> = {
      stl: Box,
      step: Settings,
      stp: Settings,
      obj: Gem,
      gltf: Sparkles,
      glb: Sparkles,
      ply: Gem,
      '3mf': Box,
      kicad_sch: Cpu,
      kicad_pcb: Cpu,
      kicad_prj: FolderOpen,
      kicad_wks: FileText,
      easyeda_json: FileText,
      easyeda_epro: FolderOpen,
      easyeda_zip: FolderOpen,
      easyeda_eproproject: FolderOpen,
      easyeda_esch: Cpu,
      easyeda_epcb: Cpu,
      gerber_rs274x: Cpu,
      gerber_drill: Cpu,
      md: NotebookText,
      pdf: FileType
    };
    const IconComponent = iconMap[file.type] || File;
    return <IconComponent size={18} />;
  };

  const getFileKindLabel = (kind: string) => {
    if (kind === 'model') return '3D Model';
    if (kind === 'kicad') return 'KiCad';
    if (kind === 'easyeda') return 'EasyEDA';
    if (kind === 'gerber') return 'Gerber';
    if (kind === 'markdown') return 'Markdown';
    if (kind === 'pdf') return 'PDF';
    if (kind === 'code') return 'Code';
    if (kind === 'image') return 'Image';
    if (kind === 'csv') return 'CSV';
    return kind;
  };

  const getFileTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      easyeda_json: 'JSON',
      easyeda_epro: 'EPRO',
      easyeda_zip: 'ZIP',
      easyeda_eproproject: 'EPROJECT',
      easyeda_esch: 'ESCH',
      easyeda_epcb: 'EPCB',
      gerber_rs274x: 'GERBER',
      gerber_drill: 'DRILL',
      gerber_zip: 'GERBER ZIP'
    };
    return (labels[type] ?? type).toUpperCase();
  };

  const renderFileRow = (
    file: HardwareFile,
    options: { key: string; paddingLeft: string; subtitle?: string; enableContextMenu?: boolean }
  ) => (
    <div
      key={options.key}
      ref={(el) => {
        if (el) rowRefs.current.set(file.path, el);
        else rowRefs.current.delete(file.path);
      }}
      className={`file-item ${selectedFile?.path === file.path ? 'selected' : ''} ${
        revealRequest?.path === file.path ? 'just-revealed' : ''
      }`}
      style={{ paddingLeft: options.paddingLeft }}
      onClick={() => setSelectedFile(file)}
      onContextMenu={
        options.enableContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, file });
            }
          : undefined
      }
    >
      <span className="file-icon">{getFileIcon(file)}</span>
      <div className="file-info">
        <div className="file-name">{file.name}</div>
        {options.subtitle && <div className="file-subtitle">{options.subtitle}</div>}
        <div className="file-meta">
          <span className="file-kind">{getFileKindLabel(file.kind)}</span>
          <span className="file-type">{getFileTypeLabel(file.type)}</span>
          <span className="file-size">{formatFileSize(file.size)}</span>
        </div>
      </div>
    </div>
  );

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const paddingLeft = `${BASE_PADDING_REM + depth * INDENT_REM}rem`;

    if (node.type === 'folder') {
      const collapsed = collapsedFolders.has(node.path);
      return (
        <div key={node.path}>
          <div
            className="file-item folder-item"
            style={{ paddingLeft }}
            onClick={() => toggleFolder(node.path)}
          >
            <span className="file-tree-chevron">
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </span>
            <span className="file-icon">
              {collapsed ? <Folder size={16} /> : <FolderOpen size={16} />}
            </span>
            <span className="file-name">{node.name}</span>
          </div>
          {!collapsed && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    if (!node.file) {
      return (
        <div
          key={node.path}
          className="file-item non-loadable"
          style={{ paddingLeft: `calc(${paddingLeft} + 1.1rem)` }}
        >
          <span className="file-icon"><File size={18} /></span>
          <div className="file-info">
            <div className="file-name">{node.name}</div>
            <div className="file-meta">
              <span className="file-size">{formatFileSize(node.size)}</span>
            </div>
          </div>
        </div>
      );
    }

    return renderFileRow(node.file, {
      key: node.path,
      paddingLeft: `calc(${paddingLeft} + 1.1rem)`
    });
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <h3>Files</h3>
        <span className="file-count">{files.length} / {allFiles.length}</span>
      </div>
      <div className="file-explorer-view-toggle">
        <span className={`view-toggle-label ${viewMode === 'pinned' ? 'active' : ''}`}>
          <Pin size={13} /> Pinned
        </span>
        <label className="view-switch">
          <input
            type="checkbox"
            checked={viewMode === 'full'}
            onChange={(e) => setViewMode(e.target.checked ? 'full' : 'pinned')}
            aria-label="Toggle between pinned files and full file tree"
          />
          <span className="view-switch-track">
            <span className="view-switch-thumb" />
          </span>
        </label>
        <span className={`view-toggle-label ${viewMode === 'full' ? 'active' : ''}`}>
          <ListTree size={13} /> Full
        </span>
      </div>
      <div className="file-list">
        {viewMode === 'full' ? (
          tree.map((node) => renderNode(node, 0))
        ) : pinnedFiles.length > 0 ? (
          pinnedFiles.map((file) => {
            const slashIndex = file.path.lastIndexOf('/');
            const subtitle = slashIndex > -1 ? file.path.slice(0, slashIndex) : undefined;
            return renderFileRow(file, {
              key: file.path,
              paddingLeft: `${BASE_PADDING_REM}rem`,
              subtitle,
              enableContextMenu: true
            });
          })
        ) : (
          <div className="file-pinned-empty">No README, PDF, or CAD/PCB files found.</div>
        )}
      </div>
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => revealInFullTree(contextMenu.file)}>
            <FolderTree size={14} /> Open in Full
          </button>
        </div>
      )}
    </div>
  );
}
