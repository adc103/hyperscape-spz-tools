import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const bundle = await build({
    entryPoints: ['frontend/scene-bundle.js'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'HyperscapeBundle',
    minify: true,
    write: false,
});
await writeFile('viewer/scene-bundle.js.gz', gzipSync(bundle.outputFiles[0].contents, {level:9}));
