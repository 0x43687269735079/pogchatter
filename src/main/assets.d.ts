// The one electron-vite ambient type this app uses (a `?asset` import bundles the file into
// out/ and resolves to its runtime path). Not `"types": ["electron-vite/node"]`: that file also
// declares process.env.ELECTRON_RENDERER_URL readonly, which would reject the packaged-build
// env scrub in index.ts.
declare module '*?asset' {
  const src: string
  export default src
}
