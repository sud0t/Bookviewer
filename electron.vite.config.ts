import { createReadStream, existsSync, statSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join, normalize, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import type { Plugin } from 'vite'

const shared = resolve('src/shared')

interface AssetMount {
  /** URL path the files appear under, relative to the app root. */
  mount: string
  /** Directory they come from. */
  source: string
  /** Sub-paths (files or directories) of `source` to expose. */
  include: string[]
}

/**
 * Some libraries load files of their own at runtime, by URL: pdf.js its
 * character maps, fonts and wasm decoders, MathJax its TeX extensions. Serve
 * those straight from node_modules in dev and copy them next to the bundle
 * when building.
 */
function runtimeAssets(mounts: AssetMount[]): Plugin {
  let outDir = ''
  return {
    name: 'runtime-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      for (const { mount, source, include } of mounts) {
        server.middlewares.use('/' + mount, (req, res, next) => {
          const relative = normalize(decodeURIComponent((req.url ?? '').split('?')[0]))
          const file = join(source, relative)
          const allowed = include.some(
            entry => file === join(source, entry) || file.startsWith(join(source, entry) + '/'),
          )
          if (!allowed || !existsSync(file) || !statSync(file).isFile()) return next()
          if (file.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm')
          if (file.endsWith('.js')) res.setHeader('content-type', 'text/javascript')
          createReadStream(file).pipe(res)
        })
      }
    },
    async closeBundle() {
      if (this.meta.watchMode) return
      for (const { mount, source, include } of mounts)
        for (const entry of include)
          await cp(join(source, entry), join(outDir, mount, entry), { recursive: true })
    },
  }
}

const assets = runtimeAssets([
  {
    mount: 'pdfjs',
    source: resolve('node_modules/pdfjs-dist'),
    include: ['cmaps', 'standard_fonts', 'wasm', 'iccs'],
  },
  {
    mount: 'mathjax',
    source: resolve('node_modules/mathjax/es5'),
    include: ['tex-svg.js', 'input/tex/extensions'],
  },
])

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Sandboxed renderers can only load CommonJS preload scripts.
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [svelte({ configFile: resolve('svelte.config.js') }), assets],
    resolve: {
      alias: {
        '@shared': shared,
        'foliate-js': resolve('vendor/foliate-js'),
      },
    },
    build: {
      target: 'chrome140',
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
})
