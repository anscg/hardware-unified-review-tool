import { useEffect, useState } from 'react';
import type { CodeFileData } from '../store/useStore';
import { fetchFileContent } from '../utils/github';

// Files larger than this are shown as plain (unhighlighted) text to avoid
// freezing the UI on highlight.js's synchronous tokenizer.
const MAX_HIGHLIGHT_SIZE = 300_000;

const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  dart: 'dart',
  groovy: 'groovy', gradle: 'groovy',
  sh: 'bash', bash: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', properties: 'ini',
  xml: 'xml', html: 'xml', htm: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  diff: 'diff', patch: 'diff',
  graphql: 'graphql', gql: 'graphql',
};

// Explicit literal import() calls so Rollup can statically analyze and code-split each
// language grammar into its own chunk. A fully dynamic `import(`...${language}.js`)` cannot
// be analyzed this way -- it builds fine but 404s at runtime in the production bundle.
const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  java: () => import('highlight.js/lib/languages/java'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  lua: () => import('highlight.js/lib/languages/lua'),
  swift: () => import('highlight.js/lib/languages/swift'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  dart: () => import('highlight.js/lib/languages/dart'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  diff: () => import('highlight.js/lib/languages/diff'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function highlight(text: string, language: string | undefined): Promise<string> {
  const loader = language ? LANGUAGE_LOADERS[language] : undefined;
  if (!loader) return escapeHtml(text);

  try {
    const hljs = (await import('highlight.js/lib/core')).default;
    if (!hljs.getLanguage(language!)) {
      const langModule = await loader();
      hljs.registerLanguage(language!, langModule.default as never);
    }
    return hljs.highlight(text, { language: language! }).value;
  } catch {
    return escapeHtml(text);
  }
}

export default function CodeViewer({ file }: { file: CodeFileData }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const [lineCount, setLineCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setHtml('');

    const load = async () => {
      try {
        const buffer = await fetchFileContent(file.url, undefined, controller.signal);
        if (cancelled) return;

        const text = new TextDecoder().decode(buffer);
        const language = text.length <= MAX_HIGHLIGHT_SIZE ? EXT_TO_LANGUAGE[file.type] : undefined;
        const highlighted = await highlight(text, language);
        if (cancelled) return;

        setLineCount(text.length === 0 ? 0 : text.split('\n').length);
        setHtml(highlighted);
        setLoading(false);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load file');
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file.url, file.type]);

  if (loading) {
    return (
      <div className="code-viewer-loading">
        <div className="spinner"></div>
        <p>Loading {file.name}...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="code-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  return (
    <div className="code-viewer">
      <div className="code-viewer-toolbar">
        <span className="code-viewer-title">{file.name}</span>
        <span className="code-viewer-detail">{lineCount} lines</span>
      </div>
      <div className="code-viewer-body">
        <pre className="code-gutter">{gutter}</pre>
        <pre className="code-content"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
      </div>
    </div>
  );
}
