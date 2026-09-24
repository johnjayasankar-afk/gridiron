/**
 * Gridiron's version. Code that runs on the server reads it from here rather than importing
 * package.json: Vercel loads functions as Node ES modules, which cannot import JSON without an
 * import attribute. tests/version.test.ts keeps it equal to package.json and the service worker.
 */
export const VERSION = '0.6.0';
