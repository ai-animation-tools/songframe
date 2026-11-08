/**
 * Витрина собирает только renderer: Wails runtime и Go-сервисы не стартуют, window.api — модель истории.
 * Отличие от 634fd94: медиа витрины лежат прямо в .storybook/assets (синтетические файлы проекта-образца
 * оригинала), поэтому отдельный шаг prepare-assets не нужен; alias совпадают с vite.config.ts.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config: StorybookConfig = {
  stories: ['../src/renderer/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  staticDirs: [{ from: './assets', to: '/media' }],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    return mergeConfig(config, {
      root,
      configFile: false,
      resolve: {
        alias: { '@shared': resolve(root, 'src/shared'), '@renderer': resolve(root, 'src/renderer'), '@platform': resolve(root, 'src/platform') }
      }
    });
  }
};
export default config;
