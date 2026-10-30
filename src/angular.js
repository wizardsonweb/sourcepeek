import * as ng from '@angular/core';
import { mount, unmount } from './client/core.js';

/**
 * Change detection cycles for the "Renders & state" view. Nothing is recorded here: listeners are only added
 * while that view is open for a component, so an app without it open pays one empty function call per cycle.
 */
function bridgeChangeDetection() {
  if (typeof window === 'undefined') return;
  const bridge = (window.__SOURCEPEEK_NG__ = window.__SOURCEPEEK_NG__ || { listeners: new Set(), cycles: 0, via: null });
  if (bridge.via) return;
  const emit = () => {
    bridge.cycles++;
    if (!bridge.listeners.size) return;
    for (const fn of bridge.listeners) {
      try {
        fn();
      } catch {}
    }
  };
  // afterEveryRender (Angular 20+) / afterRender (16.2–19): runs after every change detection cycle.
  const after = ng.afterEveryRender || ng.afterRender;
  if (typeof after === 'function') {
    try {
      after(emit);
      bridge.via = 'afterRender';
      return;
    } catch {}
  }
  // Older versions: wrap ApplicationRef.tick.
  try {
    const appRef = ng.inject(ng.ApplicationRef);
    const name = typeof appRef._tick === 'function' ? '_tick' : 'tick';
    const orig = appRef[name];
    appRef[name] = function () {
      try {
        return orig.apply(this, arguments);
      } finally {
        emit();
      }
    };
    bridge.via = 'tick';
  } catch {}
}

/**
 * Angular: add `provideSourcepeek()` to your application providers (app.config.ts, or the providers of AppModule).
 * It mounts the inspector once the app starts, in dev and production builds alike — add it only where you want it.
 */
export function provideSourcepeek() {
  const init = () => {
    // Outside the Angular zone, so Sourcepeek's own mouse and click listeners don't trigger change detection.
    let zone = null;
    try {
      zone = ng.inject(ng.NgZone);
    } catch {}
    if (zone && typeof zone.runOutsideAngular === 'function') zone.runOutsideAngular(() => mount());
    else mount();
    try {
      ng.inject(ng.DestroyRef).onDestroy(unmount);
    } catch {}
    try {
      bridgeChangeDetection();
    } catch {}
  };
  if (typeof ng.provideEnvironmentInitializer === 'function') {
    return ng.makeEnvironmentProviders([ng.provideEnvironmentInitializer(init)]);
  }
  return ng.makeEnvironmentProviders([{ provide: ng.ENVIRONMENT_INITIALIZER, multi: true, useValue: init }]);
}

export { mount, unmount };
export default provideSourcepeek;
