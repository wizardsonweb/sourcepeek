/**
 * Starts the Sourcepeek dev backend and returns an Angular CLI proxy configuration that forwards /__sourcepeek to it,
 * merged with your own configuration (an object, the array form, or the path of a JSON / JS proxy file).
 */
export declare function sourcepeekProxy(existing?: Record<string, unknown> | unknown[] | string): Promise<Record<string, unknown> | unknown[]>;
export default sourcepeekProxy;
