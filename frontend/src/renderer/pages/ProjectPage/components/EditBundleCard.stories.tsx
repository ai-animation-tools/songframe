/** Карточка пакета монтажа: список собранных пакетов перенесён, сборка ждёт медиаконвейера Go. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { platformTexts } from '@shared/texts/platform';
import { projectTexts } from '@shared/texts/project';
import type { BundleInfo } from '@shared/types';
import type { StoryOptions } from '../../../testing/storybook';
import { EditBundleCard } from './EditBundleCard';

const PROJECT = '/mock/bundle-project';
const BUNDLES: BundleInfo[] = [
  { dir: `${PROJECT}/plan/batches/edit-bundle-20261104-1200`, createdAt: '2026-11-04T12:00:00.000Z', shots: 6, videos: 5, copied: true }
];

/** listBundles отдаёт один собранный пакет; exportBundle недоступен, как в адаптере Go-версии. */
function bundleOptions(unavailable: StoryOptions['unavailable']): StoryOptions {
  return { unavailable, createApi: () => ({ production: { listBundles: async () => structuredClone(BUNDLES) } }) };
}

const meta = {
  title: 'Проект/Пакет монтажа',
  component: EditBundleCard,
  tags: ['!autodocs'],
  args: { project: PROJECT, pythonAvailable: true },
  parameters: { controls: { disable: true }, songframe: bundleOptions(['production.exportBundle']) }
} satisfies Meta<typeof EditBundleCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BuildNotMigrated: Story = {
  name: 'Сборка не перенесена · список пакетов виден',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(projectTexts.bundle.builtList);
    await expect(canvas.getByText(projectTexts.bundle.videos({ videos: 5, shots: 6 }))).toBeVisible();
    const build = canvas.getByRole('button', { name: projectTexts.bundle.build });
    await expect(build).toBeDisabled();
    await expect(build).toHaveAttribute('title', expect.stringContaining(platformTexts.unavailable));
  }
};

export const BuildAvailable: Story = {
  name: 'Сборка доступна · кнопка активна',
  parameters: { songframe: bundleOptions([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(projectTexts.bundle.builtList);
    await expect(canvas.getByRole('button', { name: projectTexts.bundle.build })).toBeEnabled();
  }
};
