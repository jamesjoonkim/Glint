import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import fsExtra from 'fs-extra';
import path from 'node:path';

/**
 * After Forge copies the prepared app dir into the .app bundle, copy
 * the externalized native module (better-sqlite3) into the bundle's
 * node_modules so the runtime require() resolves. plugin-vite strips
 * node_modules by default; auto-unpack-natives only catches modules
 * that ARE in the bundle, not externalized ones — so we copy here.
 */
/**
 * Read package.json#dependencies — a SINGLE level only. Returns names.
 */
async function depsOf(modulePath: string): Promise<string[]> {
  const pkgJsonPath = path.join(modulePath, 'package.json');
  if (!(await fsExtra.pathExists(pkgJsonPath))) return [];
  const pkg = (await fsExtra.readJson(pkgJsonPath)) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}

/**
 * Walk the dep tree starting from a set of root packages, returning every
 * transitively-required module. We ship these into the packaged node_modules
 * so Vite-externalized requires resolve correctly inside app.asar.
 */
async function resolveDepTree(roots: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift()!;
    if (found.has(name)) continue;
    const dir = path.resolve(__dirname, 'node_modules', name);
    if (!(await fsExtra.pathExists(dir))) continue;
    found.add(name);
    const children = await depsOf(dir);
    for (const c of children) queue.push(c);
  }
  return found;
}

async function shipNativeModules(buildPath: string): Promise<void> {
  // Roots match `external` in vite.main.config.ts. Their full transitive
  // dependency tree (resolved against this repo's node_modules) is shipped.
  const roots = ['better-sqlite3', 'bindings', 'tesseract.js'];
  const all = await resolveDepTree(roots);

  const dest = path.join(buildPath, 'node_modules');
  await fsExtra.ensureDir(dest);
  for (const name of all) {
    const src = path.resolve(__dirname, 'node_modules', name);
    const target = path.join(dest, name);
    if (await fsExtra.pathExists(src)) {
      await fsExtra.copy(src, target, { dereference: true });
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[forge] shipped ${all.size} module(s):`, [...all].sort().join(', '));
}

const config: ForgeConfig = {
  packagerConfig: {
    // .node bindings + worker scripts + WASM cores can't load from inside
    // an asar archive — unpack the dirs that contain them.
    asar: {
      unpack:
        '**/{*.node,*.wasm,better-sqlite3/**,bindings/**,file-uri-to-path/**,tesseract.js/**,tesseract.js-core/**}',
    },
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        shipNativeModules(buildPath)
          .then(() => callback())
          .catch(callback);
      },
    ],
    name: 'Glint',
    appBundleId: 'app.glint.macos',
    appCategoryType: 'public.app-category.productivity',
    icon: 'resources/icon',
    osxSign: process.env.APPLE_DEV_ID_APPLICATION
      ? { identity: process.env.APPLE_DEV_ID_APPLICATION }
      : undefined,
    osxNotarize:
      process.env.CI && process.env.APPLE_ID
        ? {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD!,
            teamId: process.env.APPLE_TEAM_ID!,
          }
        : undefined,
    extraResource: [
      // Bundled MLX runtime binary + sqlite-vss extension (optional).
      'resources/runtime',
      'resources/vss',
      // Editable system prompts loaded by core/models/prompts.ts at runtime.
      // Without these, the pipeline crashes with ENOENT before the LLM call.
      'prompts',
      // SQL migration files applied by history/migrations.ts at boot.
      'migrations',
    ].filter((p) => {
      try {
        require('fs').accessSync(p);
        return true;
      } catch {
        return false;
      }
    }),
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({ name: 'Glint', format: 'ULFO', overwrite: true }),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/api.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
};

export default config;
