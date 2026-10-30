import type { EnvironmentProviders } from '@angular/core';
/** Add to your application providers (app.config.ts or AppModule). Mounts the inspector in dev mode. */
export declare function provideSourcepeek(): EnvironmentProviders;
export default provideSourcepeek;
export declare function mount(): void;
export declare function unmount(): void;
