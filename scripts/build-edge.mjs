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
  define: {
    'process.env.HERMES_BUNDLED_SOUL': JSON.stringify(soul),
  },
  banner: {
    js: "import { createRequire as __hermesCreateRequire } from 'node:module'; const require = __hermesCreateRequire(import.meta.url);",
  },
});

console.log('Built privacy-safe Supabase Edge API bundle.');
