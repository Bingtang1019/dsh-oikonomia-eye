import { defineConfig } from 'tsup'

/**
 * The plugin half is bundled into `dsh/`, which is what `exports` publishes:
 * `dsh/index.js` is the plugin entry the bundle patch mounts, and
 * `dsh/invariant.js` is the separate package-owned invariant entry.
 *
 * Declarations ship beside them. `src/types.ts` merges two keys into other
 * packages' type maps — `'oikonomia-eye'` into `MessageSourceMap` and
 * `'coordinate/round'` into `SessionEventMap` — so a consumer that cannot resolve
 * this package's declarations does not see those events at all, even though the
 * log carries them.
 *
 * Every DSH package and `yaml` stay external: they are the consumer deployment's
 * own rows, and bundling a second copy of `@deepseek-ai/cordis` or
 * `@deepseek-ai/schemastery` would put two service registries in one process.
 * The plugin half is the whole build output: this package publishes no CLI and
 * no client, so it ships no `dist/`.
 */
/**
 * Declarations are built by default. `tsup` runs its declaration build through a
 * separate program, so a declaration error fails the whole build: this switch is
 * the escape hatch for environments where the peer declarations are not the ones
 * this package was written against (`pnpm run build:no-dts`). It is not a
 * supported publish mode — a tarball without `dsh/index.d.ts` cannot deliver the
 * declaration merging documented above.
 */
const dts = process.env.DSH_OIKONOMIA_EYE_NO_DTS !== '1'

export default defineConfig([
  {
    entry: { 'dsh/index': 'src/index.ts', 'dsh/invariant': 'src/invariant.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: '.',
    clean: false,
    dts,
    sourcemap: true,
    splitting: false,
    treeshake: true,
    external: [/^@deepseek-ai\//, 'yaml'],
  },
])
