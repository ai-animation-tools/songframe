/** Ресурсы приложения: в Go-версии шаблон, промпты и документы провайдеров встроены, выбор папки исходников недоступен. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import type { AppState } from '@shared/types';
import { environmentTexts } from '@shared/texts/environment';
import { AvailabilityProvider } from '../../../availability';
import { ApplicationResources } from './ApplicationResources';

const state = (overrides: Partial<AppState> = {}): AppState =>
  ({
    packaged: false,
    problems: [],
    toolsRoot: null,
    localDir: '~/.local/state/songframe-go',
    current: null,
    history: [],
    platform: 'linux',
    ...overrides
  }) as AppState;

const meta: Meta<typeof ApplicationResources> = {
  title: 'Среда/Ресурсы приложения',
  component: ApplicationResources,
  args: { state: state(), onChooseToolsRoot: fn(async () => undefined), onResetToolsRoot: fn(async () => undefined) }
};
export default meta;
type Story = StoryObj<typeof meta>;

/** Модель адаптера Go: смена папки исходников не перенесена, ресурсы встроены. */
const goAvailability = (method: string) =>
  method === 'app.setToolsRoot' ? { available: false, reason: 'Ещё не перенесено.' } : { available: true, reason: null };

export const Embedded: Story = {
  name: 'Встроенные ресурсы Go-версии',
  decorators: [
    (Story) => (
      <AvailabilityProvider value={goAvailability}>
        <Story />
      </AvailabilityProvider>
    )
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(environmentTexts.resourcesEmbedded)).toBeVisible();
    await expect(canvas.queryByText(environmentTexts.resourcesMissing)).toBeNull();
    await expect(canvas.queryByRole('button', { name: environmentTexts.chooseSources })).toBeNull();
  }
};

export const Packaged: Story = {
  name: 'Поставка',
  args: { state: state({ packaged: true }) },
  decorators: Embedded.decorators,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(environmentTexts.resourcesEmbedded)).toBeVisible();
    await expect(canvas.getByText(environmentTexts.packagedResources)).toBeVisible();
  }
};

export const SourcesSelectable: Story = {
  name: 'Запуск из исходников с выбором папки',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(environmentTexts.resourcesMissing)).toBeVisible();
    await expect(canvas.getByRole('button', { name: environmentTexts.chooseSources })).toBeVisible();
  }
};

export const Detecting: Story = {
  name: 'Состояние ещё не получено',
  args: { state: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(environmentTexts.resourcesDetecting)).toBeVisible();
  }
};
