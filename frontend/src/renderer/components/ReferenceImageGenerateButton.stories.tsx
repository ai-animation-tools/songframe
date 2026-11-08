/** Кнопка различает исполнителя изображений, выбранного текстового агента и собственную блокировку. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Stack } from '@mui/material';
import { TEST_AGENT_PROVIDER } from '@shared/testing/media-provider';
import { imageStoryOptions } from '../testing/imageStories';
import { ReferenceImageGenerateButton } from './ReferenceImageGenerateButton';

function ReferenceButtonStory({ disabledReason }: { disabledReason?: string }) {
  const [clicked, setClicked] = useState(false);
  return (
    <Stack spacing={2} alignItems="flex-start">
      <ReferenceImageGenerateButton disabledReason={disabledReason} onClick={() => setClicked(true)} />
      {clicked && <Alert severity="info">Запрошено открытие диалога для персонажа «Олег». Генерация требует отдельного согласования в диалоге.</Alert>}
    </Stack>
  );
}

const meta = {
  title: 'Общие компоненты/Кнопка генерации референса',
  component: ReferenceButtonStory,
  parameters: { songframe: imageStoryOptions() }
} satisfies Meta<typeof ReferenceButtonStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DirectProvider: Story = { name: 'Прямой провайдер' };
export const AgentExecutor: Story = {
  name: 'Исполнитель изображений — агент',
  parameters: { songframe: imageStoryOptions({ provider: TEST_AGENT_PROVIDER }) }
};
export const ProviderRequired: Story = {
  name: 'Без провайдера — причина с клавиатуры',
  parameters: { songframe: imageStoryOptions({}, false) }
};
export const OwnDisabledReason: Story = {
  name: 'Сначала сохранить персонажа',
  args: { disabledReason: 'Сохраните карточку персонажа с длинным именем, чтобы изображение можно было добавить к выбранной сущности.' }
};
