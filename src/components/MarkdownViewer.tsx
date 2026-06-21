import { useEffect, useState } from 'react';
import { Marked, type RendererObject, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import type { MarkdownFileData } from '../store/useStore';
import { fetchFileContent } from '../utils/github';

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Markdown files reference images/links with paths relative to their own location in the
// repo (e.g. "screenshot/image.png"), but we render the HTML inside our own page -- the
// browser would otherwise resolve those against our app's URL, not the repo. Resolve them
// against the raw file's own URL instead, same as GitHub does when rendering a README.
function resolveRelativeUrl(href: string, baseUrl: string): string {
  if (!href || href.startsWith('#')) return href;
  // A leading "/" means "repo root" on GitHub, but resolving it against a
  // raw.githubusercontent.com URL with the standard URL() rules would instead
  // anchor it to that host's root (e.g. "/media/x.png" -> raw.githubusercontent.com/media/x.png,
  // which 404s). Anchor root-relative paths to the owner/repo/branch prefix instead.
  if (href.startsWith('/')) {
    const match = baseUrl.match(/^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+)\//);
    if (match) return match[1] + href;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function createRenderer(baseUrl: string): RendererObject {
  return {
    image(token: Tokens.Image) {
      const alt = token.tokens
        ? this.parser.parseInline(token.tokens, this.parser.textRenderer)
        : token.text;
      const href = resolveRelativeUrl(token.href, baseUrl);
      const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<img src="${escapeAttr(href)}" alt="${escapeAttr(alt)}"${titleAttr}>`;
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = resolveRelativeUrl(token.href, baseUrl);
      const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
  };
}

export default function MarkdownViewer({ file }: { file: MarkdownFileData }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState('');

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
        const renderer = new Marked({ gfm: true, breaks: true, renderer: createRenderer(file.url) });
        const rawHtml = renderer.parse(text) as string;
        setHtml(DOMPurify.sanitize(rawHtml));
        setLoading(false);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load Markdown file');
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
      <div className="markdown-viewer-loading">
        <div className="spinner"></div>
        <p>Loading {file.name}...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="markdown-viewer-error">
        <div className="error-icon">⚠️</div>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="markdown-viewer">
      <div className="markdown-viewer-toolbar">
        <span className="markdown-viewer-title">{file.name}</span>
      </div>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
