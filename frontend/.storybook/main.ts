import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aliases = { '@shared': resolve(root, 'src/shared'), '@renderer': resolve(root, 'src/renderer'), '@platform': resolve(root, 'src/platform') };
/** Статическая витрина использует те же alias и тему, но не стартует Wails или Go-сервисы. */
const config: StorybookConfig = {
  stories: ['../src/renderer/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  async viteFinal(config) {
    return mergeConfig(config, { resolve: { alias: aliases } });
  }
};
export default config;
