import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';

const config: ForgeConfig = {
  packagerConfig: {
    // Native modules (better-sqlite3, etc.) must live OUTSIDE the asar
    // archive so dlopen can resolve their .node files at runtime.
    asar: {
      unpack: '**/{*.node,better-sqlite3,better_sqlite3.node}',
    },
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
