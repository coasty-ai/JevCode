/**
 * TUI-DESIGN-4 §1.3 — `<FullApp>`: the opt-in `ui.renderer: fullscreen` tree.
 *
 * §1.3.5 is the whole risk mitigation for a second renderer and it is a **discipline, not a second component**:
 * "`<FullApp>` reuses `Console`, `Overlay`, `Review`, `Composer`, `StatusLine`, `Transcript`'s builders and the key
 * resolver **unchanged**; only `<Static>` → `<Viewport>` and the allocator differ. If `ui.renderer` is `classic` the
 * tree is byte-for-byte today's." The only way to guarantee that literally is for the two renderers to BE the same
 * component with the two differences branched inside it — a copied tree would drift on the first round-5 change and
 * would need its own copy of every one of `<App>`'s ~40 hooks.
 *
 * So this module is the named entry point the module map (§9.1) asks for, and `<App renderer="fullscreen">` is its
 * body: `computeFullLayout` instead of `computeLayout`, `<Viewport>` instead of `<Static>`, the header at row 1, the
 * §1.3.3 scroll keys. `createTuiRenderer` (`src/tui/App.tsx`) selects between them with `selectRenderer` (§1.3.1)
 * and forces `alternateScreen: true` + `incrementalRendering: true` for this one; it does not go through this file,
 * because Ink's `render()` must be given the tree, not a wrapper that would remount on every prop change.
 */
import { App, type AppProps } from '../App.js';

/** §1.3: `<App>` with the fullscreen allocator and viewport. Every other prop is `<App>`'s, unchanged. */
export type FullAppProps = Omit<AppProps, 'renderer'>;

/**
 * §1.3: the fullscreen tree. Mounted only when `selectRenderer` (§1.3.1) accepted — at least 18 rows and 40 columns,
 * a TTY, no screen reader and a `TERM` that supports the alternate screen — and always with `alternateScreen` and
 * `incrementalRendering` forced by the caller.
 */
export function FullApp(p: FullAppProps): React.JSX.Element {
  return <App {...p} renderer="fullscreen" />;
}
