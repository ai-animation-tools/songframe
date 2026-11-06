/** Карточка пакета монтажа: список собранных пакетов и запуск новой сборки. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { projectTexts } from '@shared/texts/project';
import type { BundleInfo } from '@shared/types';
import type { StoryOptions } from '../../../testing/storybook';
import { EditBundleCard } from './EditBundleCard';

const PROJECT = '/mock/bundle-project';
const BUNDLES: BundleInfo[] = [
  { dir: `${PROJECT}/plan/batches/edit-bundle-20261104-1200`, createdAt: '2026-11-04T12:00:00.000Z', shots: 6, videos: 5, copied: true }
];

/** listBundles отдаёт один собранный пакет. */
function bundleOptions(): StoryOptions {
  return { createApi: () => ({ production: { listBundles: async () => structuredClone(BUNDLES) } }) };
}

const meta = {
  title: 'Проект/Пакет монтажа',
  component: EditBundleCard,
  tags: ['!autodocs'],
  args: { project: PROJECT },
  parameters: { controls: { disable: true }, songframe: bundleOptions() }
} satisfies Meta<typeof EditBundleCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BuildAvailable: Story = {
  name: 'Сборка доступна · кнопка активна',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(projectTexts.bundle.builtList);
    await expect(canvas.getByText(projectTexts.bundle.videos({ videos: 5, shots: 6 }))).toBeVisible();
    await expect(canvas.getByRole('button', { name: projectTexts.bundle.build })).toBeEnabled();
  }
};
