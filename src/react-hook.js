// Import this first, before React, in setups without React Fast Refresh or the React DevTools extension:
//   import 'sourcepeek/react-hook';
// It lets "Renders & state" count every React commit exactly. Without it Sourcepeek samples instead.
import { installReactHook } from './client/reactHook.js';

installReactHook();
