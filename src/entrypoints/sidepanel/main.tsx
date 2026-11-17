import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import App from './App';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { applyTheme, cachedThemePreference, resolveTheme } from '@/lib/theme';
import './style.css';

// Restore the theme before the first paint: storage.local is async, so this reads the
// localStorage mirror that App writes on every settings load/save ('auto' re-resolves the
// OS scheme synchronously via matchMedia).
applyTheme(resolveTheme(cachedThemePreference()));

// Silence Chrome's "ResizeObserver loop completed with undelivered notifications". The
// deterministic loops were removed at the source — the scroll observer skips the spacers it
// writes and watches the list as border-box, so the dropdown/card reservation writes cannot
// re-notify it (see useConversationScroll.ts) — but the panel still does legitimate per-frame
// layout work inside observer callbacks: the dropdown/page-reveal height animations re-apply the
// card offset and the list reserve on every animated frame, and streamed token batches can toggle
// the list scrollbar, rewrap rows and re-notify the scroll observer within the same frame. When
// that churn lands on a frame whose layout budget is already spent, Chrome defers the leftover
// entries to the next frame and fires this error. It is benign by design (nothing is lost — the
// entries are delivered on the next frame), so we swallow exactly this message. Do not use this
// to paper over a real write loop: an observer callback must never resize an element that any
// ResizeObserver in this document watches (the rule the 67df0ac fix enforces). Deferring the
// callbacks' writes to rAF would also stop the error, but it would make the card/reserve gluing
// and the bottom-spacer compensation lag a frame behind — the collapse-jump class of bug the
// scroll model exists to prevent.
window.addEventListener('error', (e) => {
  const message = e.message.replace(/\.$/, '');
  if (
    message === 'ResizeObserver loop completed with undelivered notifications' ||
    // Legacy name of the same notification on older Chromium.
    message === 'ResizeObserver loop limit exceeded'
  ) {
    e.preventDefault();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
