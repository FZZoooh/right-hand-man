import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import katex from 'katex';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { splitStreamingMarkdown, normalizeDisplayMath } from '@/lib/markdown-stream.mjs';
import { t } from '@/lib/i18n';
import { remarkArtifactTags, splitArtifactMarkdown } from '@/lib/artifact-tags.mjs';
import type { ArtifactContext } from '@/lib/artifacts';
import { ArtifactCard } from './ArtifactCard';
import { IconCheck, IconClose, IconCopy, IconQuote } from './icons';

// Keep the MathML annotation: it carries the original TeX, which the formula popup copies and quotes.
const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: false, output: 'htmlAndMathml' }]] as const;

const BaseUrlContext = createContext<string | undefined>(undefined);
const ArtifactRenderContext = createContext<ArtifactContext | undefined>(undefined);
const artifactRemarkPlugins = [remarkArtifactTags, ...remarkPlugins];

/**
 * Allow only protocols that are safe to open; `javascript:` / `data:` / `blob:` fall back to plain text.
 * Relative links resolve against the page being read, so they open the real target rather than a fake host.
 */
function safeHref(href: string | undefined, baseUrl: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href, baseUrl ?? 'https://pageask.invalid');
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// Structural subset of the hast nodes react-markdown passes to component overrides; importing
// @types/hast directly does not resolve under pnpm's strict node_modules layout.
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface CodeInfo {
  /** Fence info string, or null when the model emitted no language */
  language: string | null;
  code: string;
}

/** Read the fenced language and raw text out of a `pre` node; null when it is not a plain code block. */
function codeInfo(node: HastNode | undefined): CodeInfo | null {
  const code = node?.children?.find((child) => child.tagName === 'code');
  if (!code?.children || code.children.some((child) => child.type !== 'text')) return null;
  const classes = Array.isArray(code.properties?.className) ? (code.properties.className as string[]) : [];
  const languageClass = classes.find((name) => name.startsWith('language-'));
  return {
    language: languageClass ? languageClass.slice('language-'.length) : null,
    code: code.children.map((child) => child.value ?? '').join(''),
  };
}

// One dynamic import shared by every block; lib/common is already the artifact preview's bundle.
// Highlighting runs synchronously during render off this module cache: the streaming tail is
// re-parsed on every 50ms flush, and resolving the highlight through async state would paint one
// plain or stale frame between the old and new result each time.
type Hljs = typeof import('highlight.js/lib/common')['default'];
let hljs: Hljs | null = null;
let hljsPending: Promise<Hljs> | null = null;

function loadHljs(language: string | null): Promise<Hljs> {
  hljsPending ??= import('highlight.js/lib/common').then(({ default: common }) => {
    hljs = common;
    return common;
  });
  return hljsPending.then((common) => {
    // LaTeX is not part of lib/common; register it on first use, the way buildArtifactPreview does.
    const name = language?.toLowerCase();
    if ((name === 'latex' || name === 'tex') && !common.getLanguage('latex')) {
      return import('highlight.js/lib/languages/latex').then(({ default: latex }) => {
        common.registerLanguage('latex', latex);
        return common;
      });
    }
    return common;
  });
}

/** Grammar-work cap for an explicit language, the same bound buildArtifactPreview applies. */
const HLJS_CAP = 100_000;
// Auto-detection runs every common grammar on each flush for an unlabeled streaming block, so it
// gets a tighter budget than the one-shot explicit-language highlight above.
const AUTO_CAP = 32_000;

/** Synchronous highlight for the current render; null while the module is loading or out of budget. */
function highlightCode(info: CodeInfo): { html: string; label: string | null } | null {
  if (!hljs) return null;
  try {
    if (info.language) {
      if (info.code.length > HLJS_CAP) return null;
      const label = info.language.toLowerCase();
      // An explicit but unknown language stays plain; the header still names what was asked for.
      if (!hljs.getLanguage(label)) return null;
      return { html: hljs.highlight(info.code, { language: label, ignoreIllegals: true }).value, label };
    }
    if (info.code.length > AUTO_CAP) return null;
    // No info string: let hljs guess among the common languages and label the result.
    const auto = hljs.highlightAuto(info.code);
    return { html: auto.value, label: auto.language ?? null };
  } catch {
    return null;
  }
}

const CodeBlock = memo(function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const info = useMemo(() => codeInfo(node), [node]);
  const [loadedTick, setLoadedTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const artifacts = useContext(ArtifactRenderContext);

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  // The first block that needs the highlighter triggers the load; every mounted block re-renders
  // once it lands. latex/tex additionally waits for its grammar to be registered.
  useEffect(() => {
    if (!info) return;
    const latexNeeded = info.language !== null &&
      ['latex', 'tex'].includes(info.language.toLowerCase()) && !hljs?.getLanguage('latex');
    if (hljs && !latexNeeded) return;
    let alive = true;
    void loadHljs(info.language)
      .then(() => { if (alive) setLoadedTick((tick) => tick + 1); })
      .catch(() => {
        // No highlighter: keep the plain rendering that is already on screen.
      });
    return () => { alive = false; };
  }, [info]);

  const highlighted = useMemo(
    () => info ? highlightCode(info) : null,
    // loadedTick re-runs this lookup once the highlighter has finished loading.
    [info, loadedTick],
  );

  const copy = useCallback(() => {
    if (!info) return;
    void navigator.clipboard.writeText(info.code)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1400);
      })
      // The toast exists only for assistant answers; elsewhere a failed write stays silent.
      .catch(() => artifacts?.showToast(t('answer.copyFailed')));
  }, [info, artifacts]);

  if (!info) return <pre>{children}</pre>;
  const label = highlighted?.label ?? info.language?.toLowerCase() ?? '';
  return (
    <div className="md-code">
      <div className="md-code-head">
        {label && <span className="md-code-lang">{label}</span>}
        <button
          type="button"
          className="icon-btn"
          title={copied ? t('code.copied') : t('code.copy')}
          aria-label={copied ? t('code.copied') : t('code.copy')}
          onClick={copy}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <pre>
        <code className={info.language ? `language-${info.language}` : undefined}>
          {highlighted ? <span dangerouslySetInnerHTML={{ __html: highlighted.html }} /> : info.code}
        </code>
      </pre>
    </div>
  );
});

const components: Components = {
  // Fenced code blocks: language header + copy button + highlight.js coloring (see CodeBlock).
  pre: CodeBlock,
  // Open every link in a new tab: clicking one in the side panel must not replace the page being read
  a: ({ href, children }) => {
    const baseUrl = useContext(BaseUrlContext);
    const safe = safeHref(href, baseUrl);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  // Don't auto-load remote images: a model-emitted ![](https://…) leaks IP/UA and wrecks the layout,
  // so render only a clickable text link here.
  img: ({ src, alt }) => {
    const safe = typeof src === 'string' && /^https?:\/\//i.test(src) ? src : null;
    if (!safe) return <span>{alt ?? ''}</span>;
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener">
        {alt || safe}
      </a>
    );
  },
  // Let wide tables scroll instead of overflowing
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

const artifactComponents: Components = {
  ...components,
  div: ({ node, children }) => {
    const artifacts = useContext(ArtifactRenderContext);
    const name = node?.properties['data-artifact-name'];
    return artifacts && typeof name === 'string' ? <ArtifactCard name={name} artifacts={artifacts} /> : <div>{children}</div>;
  },
};

/** Completed blocks are immutable while streaming, so memo prevents re-parsing earlier answers. */
const MarkdownBlock = memo(function MarkdownBlock({ text, artifacts = false }: { text: string; artifacts?: boolean }) {
  // Normalize at render time per block (not inside splitStreamingMarkdown): the splitter only
  // slices the streamed text, and every parsed block — completed or tail — normalizes the same way.
  const source = useMemo(() => normalizeDisplayMath(text), [text]);
  return (
    <Markdown
      remarkPlugins={artifacts ? artifactRemarkPlugins : remarkPlugins}
      rehypePlugins={rehypePlugins as never}
      components={artifacts ? artifactComponents : components}
    >
      {source}
    </Markdown>
  );
});

type MathPopup = { latex: string; display: boolean };

/**
 * Renders a Markdown block (GFM tables, LaTeX math).
 * While streaming, completed blocks are memoized; the unfinished tail is re-parsed on every 50ms
 * flush so unclosed fences/tables render live. An open $$ block is hidden (tailMathStart) until
 * its closing delimiter lands and the formula appears whole — half-written TeX must not reach KaTeX.
 */
export const MarkdownView = memo(function MarkdownView({
  text,
  baseUrl,
  onQuoteMath,
  artifacts,
}: {
  text: string;
  /** URL of the page being read; relative links in the answer resolve against it */
  baseUrl?: string;
  /** Insert a formula quote; the source keeps its `$…$` delimiters and the chip shows Unicode */
  onQuoteMath?: (source: string) => void;
  /** Supply only for assistant answers; protocol tags elsewhere remain ordinary Markdown. */
  artifacts?: ArtifactContext;
}) {
  // Split both live and finished text with the same rules so the blocks parsed during streaming
  // keep their memo at completion; the tail itself is re-parsed on every flush to render it live.
  const artifactsEnabled = artifacts !== undefined;
  const split = useMemo(
    () => artifactsEnabled ? splitArtifactMarkdown(text) : splitStreamingMarkdown(text),
    [text, artifactsEnabled],
  );
  // An open $$ flow would reach KaTeX half-written: hide it and everything from its opener on, so
  // the formula appears whole when the closing delimiter lands. Safe text before it renders live.
  const tailRender = !split.tail ? null :
    split.tailMathStart < 0 ? split.tail :
    split.tailMathStart > 0 ? split.tail.slice(0, split.tailMathStart) : null;
  const artifactContext = useMemo(
    () => artifacts ? {
      settings: artifacts.settings, conversationId: artifacts.conversationId, showToast: artifacts.showToast,
      quoteFile: artifacts.quoteFile,
    } : undefined,
    [artifacts?.settings, artifacts?.conversationId, artifacts?.showToast, artifacts?.quoteFile],
  );
  const [popup, setPopup] = useState<MathPopup | null>(null);
  const [copied, setCopied] = useState(false);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const copiedTimer = useRef<number | null>(null);

  const closePopup = useCallback(() => {
    if (copiedTimer.current !== null) {
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
    setPopup(null);
    setCopied(false);
  }, []);

  useEffect(() => {
    if (!popup) return;
    // Focus the dialog itself, not its first button. autofocus on the button made Chrome treat it
    // as :focus-visible, so a control looked pre-selected the moment the popup opened and stayed
    // that way after the pointer left; a dialog focuses the container instead, and Tab reaches
    // the buttons with a real keyboard ring.
    popupRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture + preventDefault: the popup must close without also cancelling an inline edit
        // underneath it (same reasoning as the image lightbox).
        e.preventDefault();
        e.stopPropagation();
        closePopup();
      }
    };
    // The panel list scrolls under the fixed scrim; close instead of floating over unrelated
    // content. Scrolling the source block itself is part of the popup, so leave it alone.
    const onScroll = (e: Event) => {
      if (popupRef.current?.contains(e.target as Node)) return;
      closePopup();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [popup, closePopup]);

  const onMathClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    // A double-click selects a word inside the formula; it must not flash the popup open.
    if (e.detail > 1) return;
    const target = e.target as HTMLElement | null;
    const katexEl = target?.closest('.katex');
    if (!katexEl || !e.currentTarget.contains(katexEl)) return;
    // rehype-katex keeps the original source in the MathML annotation, so no second parser is needed.
    const latex = katexEl.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (!latex) return;
    setCopied(false);
    setPopup({ latex, display: Boolean(katexEl.closest('.katex-display')) });
  };

  const copyLatex = () => {
    if (!popup) return;
    void navigator.clipboard.writeText(popup.latex).then(
      () => {
        setCopied(true);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => {
          setCopied(false);
          copiedTimer.current = null;
        }, 1400);
      },
      () => {
        // Clipboard can fail (denied permission); the source block below stays selectable,
        // so the user can copy manually — no toast plumbing is worth it here.
        setCopied(false);
      },
    );
  };

  const quoteLatex = () => {
    if (!popup) return;
    // Keep the delimiters as the math marker: editorDom turns this into a Unicode chip label and
    // stores the original LaTeX in a <pageask-quote> chip; the backend converts stored chips to
    // Markdown blockquotes when building the request.
    const source = (popup.display ? '$$' : '$') + popup.latex + (popup.display ? '$$' : '$');
    closePopup();
    onQuoteMath?.(source);
  };

  // Render with the same options as the answer (rehypePlugins above) so the preview matches, and
  // with displayMode mirroring where the formula sits in the answer.
  const popupHtml = useMemo(
    () =>
      popup
        ? katex.renderToString(popup.latex, {
            throwOnError: false,
            strict: false,
            output: 'htmlAndMathml',
            displayMode: popup.display,
          })
        : '',
    [popup],
  );

  return (
    <BaseUrlContext.Provider value={baseUrl}>
      <ArtifactRenderContext.Provider value={artifactContext}>
        <div className="md" onClick={onMathClick}>
          {split.blocks.map((block, index) => (
            <MarkdownBlock key={index} text={block} artifacts={artifactsEnabled} />
          ))}
          {tailRender ? <MarkdownBlock key="tail" text={tailRender} artifacts={artifactsEnabled} /> : null}
        </div>
      </ArtifactRenderContext.Provider>
      {popup &&
        createPortal(
          // Click-to-close lives on the scrim with an exact-target check, not on a document
          // pointerdown listener: React portals bubble synthetic clicks through the component
          // tree, and a listener would see the very click that opened the popup.
          <div
            className="math-pop-scrim"
            onClick={(e) => {
              if (e.target === e.currentTarget) closePopup();
            }}
          >
            <div
              ref={popupRef}
              className="math-pop"
              role="dialog"
              aria-modal="true"
              aria-label={t('math.view')}
              tabIndex={-1}
            >
              <div className="math-pop-bar">
                {onQuoteMath && (
                  <button
                    type="button"
                    className="math-pop-btn"
                    title={t('math.quote')}
                    aria-label={t('math.quote')}
                    onClick={quoteLatex}
                  >
                    <IconQuote />
                  </button>
                )}
                <button
                  type="button"
                  className="math-pop-btn"
                  title={copied ? t('math.copied') : t('math.copy')}
                  aria-label={copied ? t('math.copied') : t('math.copy')}
                  onClick={copyLatex}
                >
                  {copied ? <IconCheck /> : <IconCopy />}
                </button>
                <button
                  type="button"
                  className="math-pop-btn"
                  title={t('math.close')}
                  aria-label={t('math.close')}
                  onClick={closePopup}
                >
                  <IconClose />
                </button>
              </div>
              <div className="math-pop-body" dangerouslySetInnerHTML={{ __html: popupHtml }} />
              <pre className="math-pop-src">{popup.latex}</pre>
            </div>
          </div>,
          document.body,
        )}
    </BaseUrlContext.Provider>
  );
});
