/** Ресурсы приложения: шаблон, промпты и документы провайдеров встроены в бинарник. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AppState } from '@shared/types';
import { environmentTexts } from '@shared/texts/environment';
import { ApplicationResources } from './ApplicationResources';

const state = (overrides: Partial<AppState> = {}): AppState =>
  ({
    packaged: false,
    problems: [],
    localDir: '~/.local/state/songframe-desktop',
    current: null,
    history: [],
    platform: 'linux',
    ...overrides
  }) as AppState;

const meta: Meta<typeof ApplicationResources> = {
  title: 'Среда/Ресурсы приложения',
  component: ApplicationResources,
  args: { state: state() }
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Embedded: Story = {
  name: 'Встроенные ресурсы приложения',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(environmentTexts.resourcesEmbedded)).toBeVisible();
    await expect(canvas.queryByText(environmentTexts.packagedResources)).toBeNull();
  }
};

export const Packaged: Story = {
  name: 'Поставка',
  args: { state: state({ packaged: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(environmentTexts.resourcesEmbedded)).toBeVisible();
    await expect(canvas.getByText(environmentTexts.packagedResources)).toBeVisible();
  }
};

export const Detecting: Story = {
  name: 'Состояние ещё не получено',
  args: { state: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(environmentTexts.resourcesDetecting)).toBeVisible();
  }
};
