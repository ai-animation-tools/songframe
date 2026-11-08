/**
 * Нативный drop Wails: пути приходят событием shell.onFilesDropped по id области, а не из DOM File.
 * История сама отправляет событие модели API и проверяет приём, количество и расширения по путям.
 */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { Stack, Typography } from '@mui/material';
import { componentsTexts } from '@shared/texts/components';
import { createStoryApi, type StoryApiSession } from '../testing/storybook';
import { FileDropZone } from './FileDropZone';

let session: StoryApiSession | null = null;

function DropJourney() {
  const [paths, setPaths] = useState<string[]>([]);
  return (
    <Stack spacing={2}>
      <FileDropZone label="Трек" kind="audio" message="Перетащите MP3" onFiles={setPaths} />
      <Typography data-testid="accepted">{paths.join(', ')}</Typography>
    </Stack>
  );
}

const meta = {
  title: 'Общие компоненты/Перетаскивание файлов',
  component: DropJourney,
  tags: ['ci'],
  parameters: {
    songframe: {
      createApi: () => {
        session = createStoryApi();
        return session;
      }
    }
  }
} satisfies Meta<typeof DropJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NativePaths: Story = {
  name: 'Пути из Wails · один MP3 принят, неверный формат и количество отклонены',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const zone = canvas.getByRole('region', { name: 'Трек' });
    await expect(zone).toHaveAttribute('data-file-drop-target');
    const drop = (paths: string[]) => session!.emit.filesDropped({ targetId: zone.id, paths });
    // Подписка ставится эффектом после первого кадра: повторяем событие, пока зона его не примет.
    await waitFor(() => {
      drop(['C:\\Музыка\\трек 1.MP3']);
      expect(canvas.getByTestId('accepted')).toHaveTextContent('C:\\Музыка\\трек 1.MP3');
    });
    // Событие другой области не принадлежит этой зоне.
    session!.emit.filesDropped({ targetId: 'другая-область', paths: ['/диск/чужой.mp3'] });
    drop(['/диск/трек.wav']);
    await expect(await body.findByText(componentsTexts.fileDrop.audio.allowed)).toBeVisible();
    drop(['/диск/а.mp3', '/диск/б.mp3']);
    await expect(await body.findByText(componentsTexts.fileDrop.audio.single)).toBeVisible();
    await expect(canvas.getByTestId('accepted')).toHaveTextContent('C:\\Музыка\\трек 1.MP3');
  }
};
