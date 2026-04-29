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
async function shipNativeModules(buildPath: string): Promise<void> {
  const nativeDeps = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
  const dest = path.join(buildPath, 'node_modules');
  await fsExtra.ensureDir(dest);
  for (const dep of nativeDeps) {
    const src = path.resolve(__dirname, 'node_modules', dep);
    const target = path.join(dest, dep);
    if (await fsExtra.pathExists(src)) {
      await fsExtra.copy(src, target, { dereference: true });
    }
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    // .node bindings can't load from inside an asar archive — unpack them
    // (plus the wrapping module dirs so the bindings package can locate them).
    asar: {
      unpack:
        '**/{*.node,better-sqlite3/**,bindings/**,file-uri-to-path/**}',
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
    extraResource: ['resources/runtime', 'resources/vss'].filter((p) => {
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
