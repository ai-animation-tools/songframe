/** Окно своего видео плана: причины недоступности загрузки, отказ Go в окне и успешная загрузка; файлы не читаются. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Stack } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import type { ManualVideo } from '@shared/types';
import { expectImplicitCloseBlocked } from '../../../testing/dialogStories';
import { OWN_VIDEO_FORMAT_ERROR } from '../../../testing/productionPageStories';
import { createStoryApi, STORY_VIDEO_PATH, type StoryOptions } from '../../../testing/storybook';
import { OwnVideoDialog } from './OwnVideoDialog';

const texts = productionTexts.ownVideo;
const manual = productionTexts.manualGeneration;
const MOV_PATH = '/mock/phone.mov';

/** Модель страницы: Go отклоняет не MP4 до создания попытки, MP4 с источником — загружает. */
function OwnVideoStory({ file }: { file: string }) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const upload = (video: ManualVideo): void => {
    if (!/\.mp4$/i.test(video.file)) {
      setError(OWN_VIDEO_FORMAT_ERROR);
      return;
    }
    setUploaded(`${video.file.split('/').pop()} · ${video.source} · ${video.costAmount ?? 'без стоимости'}`);
    setOpen(false);
  };
  return (
    <Stack spacing={2}>
      <Alert severity={uploaded ? 'success' : 'info'} data-testid="own-video-result">
        {uploaded ?? `Файл диалога: ${file}`}
      </Alert>
      {open ? <OwnVideoDialog shot="M04" busy={false} error={error} onClose={() => setOpen(false)} onUpload={upload} /> : null}
    </Stack>
  );
}

const options = (file: string): StoryOptions => ({ createApi: () => createStoryApi({ dialog: { pickFiles: async () => [file] } }) });

const meta = {
  title: 'Производство/Своё видео/Окно загрузки',
  component: OwnVideoStory,
  tags: ['!autodocs'],
  args: { file: STORY_VIDEO_PATH },
  parameters: { controls: { disable: true }, songframe: options(STORY_VIDEO_PATH) }
} satisfies Meta<typeof OwnVideoStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

const screenOf = ({ canvasElement }: Context) => within(canvasElement.ownerDocument.body);
const dialog = async (context: Context) => screenOf(context).findByRole('dialog', { name: texts.title({ shot: 'M04' }) });

/** Выбрать файл диалогом и указать источник. */
async function fill(context: Context, source: string) {
  const body = within(await dialog(context));
  await userEvent.click(body.getByRole('button', { name: new RegExp(manual.zone) }));
  await body.findByText(/Видео выбрано:/);
  await userEvent.type(body.getByRole('textbox', { name: new RegExp(manual.source) }), source);
  return body;
}

export const Upload: Story = {
  name: 'Загрузка · файл, источник и стоимость',
  tags: ['ci'],
  play: async (context) => {
    const screen = screenOf(context);
    const body = within(await dialog(context));
    await expectImplicitCloseBlocked(await dialog(context));
    await expect(body.getByText(texts.intro)).toBeVisible();
    await expect(body.getByText(texts.format)).toBeVisible();
    const upload = body.getByRole('button', { name: manual.upload });
    await expect(upload).toBeDisabled();
    await userEvent.hover(upload.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(manual.fileRequired);
    await userEvent.click(body.getByRole('button', { name: new RegExp(manual.zone) }));
    await body.findByText(manual.chosen({ name: 'story-video.mp4' }));
    // Без источника загрузить нельзя: источник обязателен.
    await userEvent.hover(body.getByRole('button', { name: manual.upload }).parentElement!);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(manual.sourceRequired));
    await userEvent.type(body.getByRole('textbox', { name: new RegExp(manual.source) }), 'Снято на телефон');
    await userEvent.type(body.getByRole('spinbutton', { name: manual.cost }), '300');
    await waitFor(() => expect(body.getByRole('button', { name: manual.upload })).toBeEnabled());
    await userEvent.click(body.getByRole('button', { name: manual.upload }));
    await waitFor(() => expect(screen.getByTestId('own-video-result')).toHaveTextContent('story-video.mp4 · Снято на телефон · 300'));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
};

export const NotMp4: Story = {
  name: 'Не MP4 · отказ остаётся в окне с выбранными полями',
  args: { file: MOV_PATH },
  parameters: { songframe: options(MOV_PATH) },
  play: async (context) => {
    const body = await fill(context, 'Телефон');
    await userEvent.click(body.getByRole('button', { name: manual.upload }));
    await expect(await body.findByText(OWN_VIDEO_FORMAT_ERROR)).toBeVisible();
    await expect(body.getByRole('textbox', { name: new RegExp(manual.source) })).toHaveValue('Телефон');
    await userEvent.click(screenOf(context).getByRole('button', { name: commonTexts.cancel }));
    await expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument();
  }
};
