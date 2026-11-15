import esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/index.js',
  external: [],
  sourcemap: true,
  minify: false,
})
console.log('host/dsh: bundled dist/index.js')
