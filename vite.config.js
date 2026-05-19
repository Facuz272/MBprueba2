import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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
 * Custom plugin: optimizeImages
 * ----------------------------------------------------------------------
 * Single, race-free image-optimization pass. Replaces the previous
 * 2-stage pipeline (vite-plugin-image-optimizer + resizeOversizeImages),
 * which had a destructive race: both ran in closeBundle and both wrote
 * to the same destination paths. The result was non-deterministic
 * 0-byte JPEGs on disk for whichever files happened to be in flight
 * during the overlap. Two distinct files were observed bricked in
 * production this way (request your quote.jpeg, then We schedule the
 * job .jpeg after the first fix).
 *
 * THIS plugin is the only writer. It:
 *   - Walks dist/images/ sequentially after Vite copies public/* over.
 *   - For each JPEG/PNG: re-encodes at quality 78–80 with mozjpeg
 *     (matches what the upstream package did), AND resizes to
 *     MAX_WIDTH if the source is wider (the new value-add).
 *   - Writes to a unique temp file and rename()s atomically into
 *     place, so even if anything ever runs concurrently the final
 *     file is always either the previous version or the full new one.
 *   - Never throws upward: bad images log and skip, build never fails.
 *
 * sharp is pinned to a single thread + tiny cache so we don't ever
 * trip the SIGBUS / libvips memory-pressure path we hit earlier.
 * --------------------------------------------------------------------*/
const MAX_WIDTH = 2000;

function optimizeImages() {
  return {
    name: 'mb-optimize-images',
    apply: 'build',
    async closeBundle() {
      const root = path.resolve('dist/images');
      let count = 0, saved = 0, skipped = 0, errored = 0;

      const optimizeOne = async (full) => {
        const before = (await stat(full)).size;

        // Metadata read on a short-lived sharp instance.
        let metaInstance = sharp(full, { failOn: 'none' });
        let meta;
        try {
          meta = await metaInstance.metadata();
        } finally {
          if (typeof metaInstance.destroy === 'function') metaInstance.destroy();
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
          if (buf.length === 0) {
            // Hard guard: never overwrite a real file with an empty buffer,
            // no matter how the encoder behaves.
            skipped++;
            return;
          }
          if (buf.length < before) {
            /* ATOMIC WRITE via temp + rename. Even with no other writer
               in play, this also protects against partial writes on
               crash / SIGINT mid-build — the destination either holds
               the previous version or the full new one, never half. */
            const tmp = `${full}.opt-${process.pid}-${Date.now()}.tmp`;
            try {
              await writeFile(tmp, buf);
              await rename(tmp, full);
            } catch (renameErr) {
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
          // Skip any leftover temp files from previous interrupted builds.
          if (/\.opt-\d+-\d+\.tmp$/.test(e.name)) continue;
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
        `\n📐 optimizeImages: ${count} written, ${skipped} skipped, ${errored} errored, saved ${mb} MB`
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
 *     → optimizeImages plugin re-encodes + resizes in one race-free pass
 *
 * `base: '/'` for the custom domain (mbsoftwashmiami.com) so asset
 * URLs are written at the apex root. `build.target: 'es2020'` matches
 * modern browsers + iOS 14+.
 * --------------------------------------------------------------------*/
export default defineConfig({
  /* Custom domain (mbsoftwashmiami.com) lives at the DOMAIN ROOT, so
     every Vite-managed absolute asset URL must be prefixed with `/`
     (no subpath). A public/CNAME file is shipped on every build so
     the custom domain configuration on GitHub Pages survives each
     redeploy. */
  base: '/',
  plugins: [
    react(),
    optimizeImages(),
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
