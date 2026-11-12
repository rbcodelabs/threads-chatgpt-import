import esbuild from 'esbuild';
// TCI_OUTFILE lets the smoke test build the same bundle into a temp dir.
await esbuild.build({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', 'electron'], format: 'cjs', platform: 'node', target: 'es2022', outfile: process.env.TCI_OUTFILE || 'main.js', sourcemap: false });
