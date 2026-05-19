import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import sharp from 'sharp';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* ----------------------------------------------------------------------
 * Custom plugin: resizeOversizeImages
 * ----------------------------------------------------------------------
 * vite-plugin-image-optimizer only re-encodes; it does NOT resize. Most
 * of our source photos are 3000–4000 px wide but are displayed at
 * max ~1000 px (B/A slider) or ~400 px (service card). Re-encoding at
 * q:78 saved ~13%; resizing to 2000 px and recompressing saves 70–90 %
 * on those same files.
 *
 * This plugin runs at `closeBundle`, AFTER vite-plugin-image-optimizer
 * has finished, so we get the best of both: the upstream plugin handles
 * small files + PNGs efficiently, and this pass handles the big photos.
 * --------------------------------------------------------------------*/
const MAX_WIDTH = 2000;
function resizeOversizeImages() {
  return {
    name: 'mb-resize-oversize-images',
    apply: 'build',
    async closeBundle() {
      const root = path.resolve('dist/images');
      let count = 0, saved = 0;
      const walk = async (dir) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { await walk(full); continue; }
          if (!/\.(jpe?g|png)$/i.test(e.name)) continue;
          try {
            const before = (await stat(full)).size;
            const meta = await sharp(full).metadata();
            // Skip if already within target width AND already small.
            if ((!meta.width || meta.width <= MAX_WIDTH) && before < 350_000) continue;
            let pipe = sharp(full, { failOn: 'none' });
            if (meta.width && meta.width > MAX_WIDTH) {
              pipe = pipe.resize({ width: MAX_WIDTH, withoutEnlargement: true });
            }
            const isJpg = /\.jpe?g$/i.test(e.name);
            const buf = await (isJpg
              ? pipe.jpeg({ quality: 80, progressive: true, mozjpeg: true })
              : pipe.png({ compressionLevel: 9, palette: true })
            ).toBuffer();
            if (buf.length < before) {
              await writeFile(full, buf);
              saved += before - buf.length;
              count++;
              const pct = ((1 - buf.length / before) * 100).toFixed(0);
              const kb = (s) => (s / 1024).toFixed(0) + ' KB';
              console.log(`  ↳ ${path.relative('dist', full)}: ${kb(before)} → ${kb(buf.length)} (-${pct}%)`);
            }
          } catch (err) {
            console.warn(`  ⚠ skipped ${full}: ${err.message}`);
          }
        }
      };
      await walk(root);
      const mb = (saved / 1024 / 1024).toFixed(2);
      console.log(`\n📐 resizeOversizeImages: ${count} files, saved ${mb} MB`);
    },
  };
}

// Vite config — single-page app with the existing index.html as the entry.
// The React plugin handles JSX compilation at BUILD time (not in the browser),
// which is the entire reason for this build step.
//
// vite-plugin-image-optimizer runs sharp on every JPEG/PNG/SVG that flows
// through the build OR sits in public/. With `includePublic: true` it walks
// public/images/ and re-encodes each photo aggressively. The settings below
// were tuned for big residential exterior photos: mozjpeg at q:78 (visually
// indistinguishable from q:95 source for outdoor photos), progressive scan
// so previews paint earlier on slow connections.
//
// `base: './'` produces relative asset paths in dist/index.html so the build
// can be deployed to a sub-path or opened from a static host without rewrite.
//
// `build.minify: 'esbuild'` (the default) keeps the bundle small and the build
// fast. `build.target: 'es2020'` matches modern browsers + iOS Safari 14+.
//
// `build.assetsInlineLimit: 0` keeps all assets as external files (no base64
// inlining) so the existing /images/ structure stays intact.

export default defineConfig({
  base: './',
  plugins: [
    react(),
    ViteImageOptimizer({
      /* Process JPGs and PNGs that live in public/ — that's where the
         actual ~57 MB of source photos sits. Without this flag the plugin
         would only see images explicitly imported into the JS bundle. */
      includePublic: true,
      logStats: true,

      /* JPEG: mozjpeg encoder gives ~10% smaller files than libjpeg at the
         same quality. q:78 is the sweet spot for outdoor cleaning photos —
         no visible artefacts on residential exteriors, paver textures, or
         roof tiles. progressive=true so the browser shows a low-res
         preview while the full image streams. */
      jpeg: {
        quality: 78,
        progressive: true,
        mozjpeg: true,
      },
      jpg: {
        quality: 78,
        progressive: true,
        mozjpeg: true,
      },

      /* PNG: lossless palette optimization. Logo + UI graphics stay crisp. */
      png: {
        quality: 80,
        compressionLevel: 9,
        palette: true,
      },

      /* WebP: ~30% smaller than JPEG. Modern browsers will get these
         automatically when served via a CDN that respects Accept headers
         or a <picture> tag is added later. */
      webp: {
        quality: 80,
        lossless: false,
      },

      /* AVIF: even smaller than WebP, supported in modern Safari/Chrome. */
      avif: {
        quality: 75,
        lossless: false,
      },

      /* Cache so repeated `npm run build` doesn't re-encode unchanged files. */
      cache: true,
      cacheLocation: 'node_modules/.cache/vite-plugin-image-optimizer',
    }),
    /* Resize pass — runs after vite-plugin-image-optimizer at closeBundle.
       Handles the big photos that the upstream plugin can only modestly
       compress because they're already decent JPEGs but vastly oversized. */
    resizeOversizeImages(),
  ],
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Predictable filenames help when wiring up CDN cache headers.
        entryFileNames: 'assets/main-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
