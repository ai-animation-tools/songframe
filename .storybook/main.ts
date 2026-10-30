/** Витрина собирает только renderer: конфигурация Electron и его плагины сюда не загружаются. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  staticDirs: [{ from: '../build/storybook-assets', to: '/media' }],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    return mergeConfig(config, {
      root,
      configFile: false,
      resolve: { alias: { '@shared': resolve(root, 'src/shared'), '@renderer': resolve(root, 'src/renderer/src') } }
    });
  }
};
export default config;
