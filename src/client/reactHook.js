// The React DevTools global hook is how React reports every commit. React looks for it once, when react-dom
// loads, so it has to exist before that. In dev it usually does: React Fast Refresh (Vite, Next.js, CRA) and the
// React DevTools extension both create it. This installs a minimal one for setups that have neither.
// "Renders & state" wraps hook.onCommitFiberRoot only while it tracks a component.

export function installReactHook() {
  try {
    const w = window;
    if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
    let id = 0;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      supportsFiber: true,
      isDisabled: false,
      __sourcepeek: true,
      inject(renderer) {
        id++;
        this.renderers.set(id, renderer);
        return id;
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot() {},
      onPostCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      checkDCE() {},
    };
  } catch {}
}

/** The same, as an inline <script> for index.html (Vite injects it before any module loads). */
export const HOOK_SOURCE = `(${installReactHook.toString()})();`;
