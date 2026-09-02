import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const outputDirectory = path.join(root, 'supabase', 'functions', 'api');
const soul = await readFile(path.join(root, 'soul.md'), 'utf8');


await mkdir(outputDirectory, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['./apps/api/src/app.ts'],
  outfile: 'supabase/functions/api/hermes-api.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  // Adding a PDF reader took the bundle past the size Supabase will accept for
  // a deploy, which returns a bare 413. Minifying brings it to 3.5 MB, below
  // even what it was before, and shortens every cold start as a side effect.
  minify: true,
  // Without this, minification renames every function and class, and the log
  // line for a failed turn stops naming anything a person can look up.
  keepNames: true,
  define: {
    'process.env.HERMES_BUNDLED_SOUL': JSON.stringify(soul),
  },
  banner: {
    js: "import { createRequire as __hermesCreateRequire } from 'node:module'; const require = __hermesCreateRequire(import.meta.url);",
  },
});

console.log('Built privacy-safe Supabase Edge API bundle.');
