import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

/** "Thinking" placeholder before answer text: fades in, then fades out and collapses once text arrives */
export function ThinkingFade({ show }: { show: boolean }) {
  const [mounted, setMounted] = useState(show);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (show) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(timer);
  }, [show, mounted]);

  if (!mounted) return null;
  return <div className={`thinking${closing ? ' out' : ''}`}>{t('answer.thinking')}</div>;
}

/** Thinking/tool block: open while streaming, auto-collapsed after; a manual collapse is not undone by later tokens */
export function RoundPanel({ active, summary, children }: { active: boolean; summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const wasActive = useRef(active);
  // Bumped every time the block opens; rekeys the body so the expand animation replays. A plain
  // `.round[open]` animation is not enough: Chromium ≥131 keeps closed-<details> content rendered
  // (content-visibility: hidden on ::details-content), so the animation survives the collapse
  // (fill mode both) and never restarts on reopen.
  const [openEpoch, setOpenEpoch] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onToggle = () => {
      if (el.open) setOpenEpoch((epoch) => epoch + 1);
    };
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, []);

  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    if (ref.current) ref.current.open = active;
  }, [active]);

  return (
    <details ref={ref} className="round" open={active}>
      <summary>{summary}</summary>
      <div className="round-body" key={openEpoch}>
        {children}
      </div>
    </details>
  );
}
