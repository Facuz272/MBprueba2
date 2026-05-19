import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import sharp from 'sharp';
import { readdir, stat, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/* ----------------------------------------------------------------------
 * GLOBAL sharp tuning
 * ----------------------------------------------------------------------
 * sharp wraps libvips, which by default spins up one worker thread per
 * physical core. With 50+ photos in flight that means many concurrent
 * native-memory mapped allocations — on macOS this can produce SIGBUS
 * ("bus error") if the page mapper hits a misaligned region or runs out
 * of contiguous virtual address space.
 *
 * We pin to ONE thread so processing is fully serial inside libvips,
 * AND set an explicit small RAM cap so libvips releases buffers between
 * images instead of accumulating them. Build time barely changes (we're
 * already serial at the JS layer); the trade-off is stability.
 * --------------------------------------------------------------------*/
sharp.concurrency(1);
sharp.cache({ memory: 64, items: 50, files: 0 });

/* ----------------------------------------------------------------------
 * Custom plugin: resizeOversizeImages
 * ----------------------------------------------------------------------
 * vite-plugin-image-optimizer only re-encodes; it does NOT resize. Most
 * of our source photos are 3000–4000 px wide but are displayed at
 * max ~1000 px (B/A slider) or ~400 px (service card). Re-encoding at
 * q:78 saved ~13 %; resizing to 2000 px and recompressing saves 70–90 %
 * on those same files.
 *
 * SAFETY (post-bus-error)
 *   - Strictly sequential file processing (for…of with await per file).
 *   - One sharp() instance per file, explicitly destroyed via `.destroy()`
 *     after the toBuffer() resolves so libvips releases its mapped pages
 *     before the next file allocates new ones.
 *   - try/catch around the whole per-file block: a bad image logs and
 *     skips, never aborts the build.
 *   - Skips files already small + within the target width — fewer sharp
 *     allocations on warm cache.
 * --------------------------------------------------------------------*/
const MAX_WIDTH = 2000;
const SKIP_IF_UNDER = 350_000; // bytes — file is already lean

function resizeOversizeImages() {
  return {
    name: 'mb-resize-oversize-images',
    apply: 'build',
    async closeBundle() {
      const root = path.resolve('dist/images');
      let count = 0, saved = 0, skipped = 0, errored = 0;

      const optimizeOne = async (full) => {
        const before = (await stat(full)).size;

        // Cheap metadata read — uses a small sharp instance we tear down.
        let metaInstance = sharp(full, { failOn: 'none' });
        let meta;
        try {
          meta = await metaInstance.metadata();
        } finally {
          if (typeof metaInstance.destroy === 'function') metaInstance.destroy();
        }

        // Early-out if nothing to do.
        if ((!meta.width || meta.width <= MAX_WIDTH) && before < SKIP_IF_UNDER) {
          skipped++;
          return;
        }

        // Real optimization pipeline — fresh sharp instance, single-use.
        let pipe = sharp(full, { failOn: 'none' });
        try {
          if (meta.width && meta.width > MAX_WIDTH) {
            pipe = pipe.resize({ width: MAX_WIDTH, withoutEnlargement: true });
          }
          const isJpg = /\.jpe?g$/i.test(full);
          const encoded = isJpg
            ? pipe.jpeg({ quality: 80, progressive: true, mozjpeg: true })
            : pipe.png({ compressionLevel: 9, palette: true });

          const buf = await encoded.toBuffer();
          if (buf.length < before) {
            /* ATOMIC WRITE: vite-plugin-image-optimizer can still be
               flushing its own output to the same destination at this
               point in closeBundle. A plain writeFile(full, buf) can
               race with that flush and end up truncated to 0 bytes
               (observed reliably on a 3840x5120 JPEG). Writing to a
               unique temp path and rename-ing is atomic on POSIX
               filesystems — the rename swaps the inode, so the final
               file is either the old one or the full new one, never
               an empty intermediate. */
            const tmp = `${full}.opt-${process.pid}-${Date.now()}.tmp`;
            try {
              await writeFile(tmp, buf);
              await rename(tmp, full);
            } catch (renameErr) {
              // Best-effort cleanup if the rename failed mid-flight.
              try { await unlink(tmp); } catch {}
              throw renameErr;
            }
            saved += before - buf.length;
            count++;
            const pct = ((1 - buf.length / before) * 100).toFixed(0);
            const kb = (s) => (s / 1024).toFixed(0) + ' KB';
            console.log(`  ↳ ${path.relative('dist', full)}: ${kb(before)} → ${kb(buf.length)} (-${pct}%)`);
          } else {
            skipped++;
          }
        } finally {
          if (typeof pipe.destroy === 'function') pipe.destroy();
        }
      };

      const walk = async (dir) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { await walk(full); continue; }
          if (!/\.(jpe?g|png)$/i.test(e.name)) continue;
          try {
            await optimizeOne(full);
          } catch (err) {
            errored++;
            console.warn(`  ⚠ skipped ${path.relative('dist', full)}: ${err.message}`);
          }
        }
      };

      await walk(root);
      const mb = (saved / 1024 / 1024).toFixed(2);
      console.log(
        `\n📐 resizeOversizeImages: ${count} written, ${skipped} skipped, ${errored} errored, saved ${mb} MB`
      );
    },
  };
}

/* ----------------------------------------------------------------------
 * Vite config
 * ----------------------------------------------------------------------
 * Build pipeline:
 *   vite build
 *     → copies public/* to dist/*
 *     → vite-plugin-image-optimizer compresses (in-place re-encode only)
 *     → resizeOversizeImages plugin downsizes huge JPEGs to MAX_WIDTH
 *
 * `base: './'` produces relative asset paths so dist/ can be hosted from
 * any subpath. `build.target: 'es2020'` matches modern browsers + iOS 14+.
 * --------------------------------------------------------------------*/
export default defineConfig({
  /* Custom domain (mbsoftwashmiami.com) lives at the DOMAIN ROOT, so
     every Vite-managed absolute asset URL must be prefixed with `/`
     (no subpath). Previously this was '/MBprueba2/' for the GH Pages
     project URL (https://Facuz272.github.io/MBprueba2/); after the
     CNAME was wired up the site serves at the apex domain instead,
     and asset paths like /MBprueba2/assets/main-[hash].js 404'd —
     producing the infinite "LOADING..." spinner because the JS bundle
     never loaded.
     A `public/CNAME` file is shipped on every build so the custom
     domain configuration on GitHub Pages survives each redeploy. */
  base: '/',
  plugins: [
    react(),
    ViteImageOptimizer({
      includePublic: true,
      logStats: true,

      /* JPEG: mozjpeg encoder, q:78 — visually identical to source for
         outdoor cleaning photos. progressive=true so the browser paints
         a low-res preview while the full image streams. */
      jpeg: { quality: 78, progressive: true, mozjpeg: true },
      jpg:  { quality: 78, progressive: true, mozjpeg: true },

      /* PNG: lossless palette + max zlib compression. */
      png:  { quality: 80, compressionLevel: 9, palette: true },

      /* WebP and AVIF intentionally disabled.
         Reasons:
         1) AVIF encoding is extremely CPU- and memory-heavy. With
            sharp pinned to 1 thread (above) it works, but pre-fix this
            was a likely SIGBUS trigger.
         2) Nothing on the page actually consumes the .webp/.avif siblings
            — our <img> tags reference the .jpeg directly, with no
            <picture> source-set fallback. Generating them is wasted disk
            + build time. Re-enable if/when we wire up <picture>. */

      /* Cache so repeated `npm run build` doesn't re-encode unchanged
         files. Speeds incremental builds from ~30 s → ~5 s. */
      cache: true,
      cacheLocation: 'node_modules/.cache/vite-plugin-image-optimizer',
    }),
    resizeOversizeImages(),
  ],
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
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
