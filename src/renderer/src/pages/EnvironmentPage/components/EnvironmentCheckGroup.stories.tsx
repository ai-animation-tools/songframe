/** Группы сохраняют смысл обязательных и отдельно устанавливаемых ресурсов. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { environmentTexts } from '@shared/texts/environment';
import { EnvironmentCheckGroup } from './EnvironmentCheckGroup';
import { ENVIRONMENT_STORY_LONG_PATH, environmentCheck, environmentChecks } from '../../../testing/environmentStories';

const meta: Meta<typeof EnvironmentCheckGroup> = {
  title: 'Среда/Группа проверок',
  component: EnvironmentCheckGroup,
  args: { title: environmentTexts.coreGroup, category: 'core', items: environmentChecks().filter((check) => check.bundled) }
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = { name: 'Ресурсы поставки доступны' };
export const Mixed: Story = {
  name: 'Готово · выполняется · ожидает · ошибка',
  args: {
    items: [
      environmentCheck(),
      environmentCheck({ id: 'numpy', label: 'NumPy', status: 'running', ok: false }),
      environmentCheck({ id: 'pillow', label: 'Pillow', status: 'pending', ok: false }),
      environmentCheck({ id: 'tools', label: 'Комплекс SongFrame', ok: false, detail: 'Ресурсы не найдены.' })
    ]
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(4);
    await expect(canvas.getByRole('progressbar', { name: 'NumPy: выполняется проверка' })).toBeVisible();
    await expect(canvas.getByText('Ожидает проверки')).toBeVisible();
    await expect(canvas.getByText('Ресурсы не найдены.')).toBeVisible();
  }
};
export const OptionalPrograms: Story = {
  name: 'Отдельные программы · необязательность объяснена',
  args: { title: environmentTexts.externalGroup, category: 'external', items: environmentChecks().filter((check) => check.external) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Эти программы устанавливаются отдельно по необходимости; без них приложение работает.')).toBeVisible();
    await expect(canvas.getByText('—')).toBeVisible();
  }
};
export const ModelLongPath: Story = {
  name: 'Установленная модель · длинный путь',
  args: {
    title: environmentTexts.modelGroup,
    category: 'model',
    items: [
      environmentCheck({
        id: 'whisper-model',
        label: environmentTexts.main.whisperModelLabel,
        bundled: false,
        productionOnly: true,
        detail: ENVIRONMENT_STORY_LONG_PATH
      })
    ]
  }
};
