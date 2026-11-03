// The electron-vite ambient types this app uses: a `?asset` import bundles the file into out/ and
// resolves to its runtime path; a `?modulePath` import builds the module as its own bundle (a
// worker thread's entry) and resolves to that bundle's path. Not
// `"types": ["electron-vite/node"]`: that file also declares process.env.ELECTRON_RENDERER_URL
// readonly, which would reject the packaged-build env scrub in index.ts.
declare module '*?asset' {
  const src: string
  export default src
}

declare module '*?modulePath' {
  const src: string
  export default src
}
