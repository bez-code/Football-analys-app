/**
 * Declarations for the two bundled-binary packages, which ship JavaScript with
 * no types of their own.
 *
 * Both are intentionally untyped at the package level: `index.js` exports a
 * *string path* to a host binary, but its `types/index.d.ts` declares a
 * `module`-style object. The main process uses the runtime value (a path), so
 * these are the shapes that actually apply.
 */
declare module 'ffmpeg-static' {
  const path: string;
  export default path;
}

declare module 'ffprobe-static' {
  const mod: { path: string };
  export default mod;
}
