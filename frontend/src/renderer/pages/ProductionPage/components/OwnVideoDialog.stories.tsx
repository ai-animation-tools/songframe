/**
 * Окно своего видео плана: причины недоступности загрузки, отказ Go в окне, успешная загрузка и необязательный раздел
 * «Как сделано видео» (входы генерации с ролями и промпт); файлы не читаются.
 */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Stack } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import type { ManualVideo, OwnVideoGeneration } from '@shared/types';
import { expectImplicitCloseBlocked } from '../../../testing/dialogStories';
import { OWN_VIDEO_FORMAT_ERROR } from '../../../testing/productionPageStories';
import { createStoryApi, STORY_VIDEO_PATH, type StoryOptions } from '../../../testing/storybook';
import { OwnVideoDialog } from './OwnVideoDialog';

const texts = productionTexts.ownVideo;
const generationTexts = texts.generation;
const manual = productionTexts.manualGeneration;
const MOV_PATH = '/mock/phone.mov';
/** Изображения входов: имя файла витрины одно, папки разные — так у каждого входа есть превью. */
const IMAGE_PATHS = ['/mock/first/story-image.png', '/mock/middle/story-image.png', '/mock/last/story-image.png'];

/** Сведения о генерации одной строкой для проверки: «роль:папка» через запятую и промпт после « · ». */
const generationLine = ({ inputs, prompt }: OwnVideoGeneration): string =>
  `${inputs.map((input) => `${input.role}:${input.file.split('/').at(-2)}`).join(', ') || 'входов нет'} · ${prompt || 'без промпта'}`;

/** Модель страницы: Go отклоняет не MP4 до создания попытки, MP4 с источником — загружает. */
function OwnVideoStory({ file, unaccepted = null }: { file: string; unaccepted?: string | null }) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const upload = (video: ManualVideo, generation: OwnVideoGeneration): void => {
    if (!/\.mp4$/i.test(video.file)) {
      setError(OWN_VIDEO_FORMAT_ERROR);
      return;
    }
    setUploaded(`${video.file.split('/').pop()} · ${video.source} · ${video.costAmount ?? 'без стоимости'} · ${generationLine(generation)}`);
    setOpen(false);
  };
  return (
    <Stack spacing={2}>
      <Alert severity={uploaded ? 'success' : 'info'} data-testid="own-video-result">
        {uploaded ?? `Файл диалога: ${file}`}
      </Alert>
      {open ? <OwnVideoDialog shot="M04" unaccepted={unaccepted} busy={false} error={error} onClose={() => setOpen(false)} onUpload={upload} /> : null}
    </Stack>
  );
}

/** Диалог выбора: видео для формы видео, изображения (фильтр изображений) — для входов генерации. */
const options = (file: string, images: string[] = IMAGE_PATHS.slice(0, 2)): StoryOptions => ({
  createApi: () =>
    createStoryApi({ dialog: { pickFiles: async (pick) => (pick?.filters?.some((filter) => filter.extensions.includes('png')) ? images : [file]) } })
});

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
    // Раздел о генерации необязателен и свёрнут: видео с телефона он не нужен.
    const section = body.getByRole('button', { name: new RegExp(generationTexts.heading) });
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    await expect(section).toHaveTextContent(generationTexts.optional);
    // Других непринятых результатов нет — и предупреждения нет.
    await expect(body.queryByText(/Непринятый результат/)).not.toBeInTheDocument();
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
    // Раздел «Как сделано видео» не трогали: Go получает пустые входы и промпт, как у видео с телефона.
    await waitFor(() =>
      expect(screen.getByTestId('own-video-result')).toHaveTextContent('story-video.mp4 · Снято на телефон · 300 · входов нет · без промпта')
    );
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
};

export const UnacceptedResult: Story = {
  name: 'Другая попытка ждёт решения · предупреждение об удалении её результата при приёмке',
  tags: ['ci'],
  args: { unaccepted: texts.unacceptedAttempt({ label: 'Попытка 1', paid: true }) },
  play: async (context) => {
    const body = within(await dialog(context));
    const warning = body.getByText(texts.unaccepted({ attempts: 'Попытка 1 (оплаченная генерация)' }));
    await expect(warning).toBeVisible();
    await expect(warning.closest('[role="alert"]')).not.toBeNull();
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

/** Раскрыть раздел «Как сделано видео» и добавить изображения диалогом выбора. */
async function addImages(context: Context) {
  const body = within(await dialog(context));
  await userEvent.click(body.getByRole('button', { name: new RegExp(generationTexts.heading) }));
  await userEvent.click(await body.findByRole('button', { name: new RegExp(`^${generationTexts.zone}`) }));
  return body;
}

/** Строка входа по номеру и её выбор роли. */
const inputRow = (body: ReturnType<typeof within>, index: number) =>
  within(body.getByRole('listitem', { name: new RegExp(`^${generationTexts.input({ index })}:`) }));

export const GenerationInputs: Story = {
  name: 'Как сделано видео · два входа по порядку и промпт',
  tags: ['ci'],
  play: async (context) => {
    const screen = screenOf(context);
    const body = await addImages(context);
    await expect(await body.findAllByRole('listitem')).toHaveLength(2);
    // Роли по умолчанию: первый вход — первый кадр, последний — последний кадр; превью у каждого.
    await expect(inputRow(body, 1).getByRole('combobox')).toHaveTextContent(generationTexts.roles.first);
    await expect(inputRow(body, 2).getByRole('combobox')).toHaveTextContent(generationTexts.roles.last);
    await expect(inputRow(body, 1).getByRole('button', { name: generationTexts.moveUp({ name: generationTexts.input({ index: 1 }) }) })).toBeDisabled();
    await expect(inputRow(body, 1).getByRole('img')).toBeInTheDocument();
    // Указанное видно заметным статусом в заголовке раздела.
    const section = body.getByRole('button', { name: new RegExp(generationTexts.heading) });
    await expect(within(section).getByText(generationTexts.filled({ inputs: 2, prompt: false }))).toBeVisible();
    await userEvent.type(body.getByRole('textbox', { name: generationTexts.prompt }), 'Камера медленно наезжает');
    await expect(within(section).getByText(generationTexts.filled({ inputs: 2, prompt: true }))).toBeVisible();
    // Перестановка: роли, не выбранные вручную, следуют за порядком.
    await userEvent.click(inputRow(body, 2).getByRole('button', { name: generationTexts.moveUp({ name: generationTexts.input({ index: 2 }) }) }));
    await expect(inputRow(body, 1).getByRole('combobox')).toHaveTextContent(generationTexts.roles.first);
    await userEvent.click(inputRow(body, 1).getByRole('button', { name: generationTexts.moveDown({ name: generationTexts.input({ index: 1 }) }) }));
    // Ещё одно изображение встаёт в конец последним кадром, прежний последний становится промежуточным; затем его убирают.
    await userEvent.click(body.getByRole('button', { name: generationTexts.add }));
    await expect(await body.findAllByRole('listitem')).toHaveLength(4);
    await expect(inputRow(body, 2).getByRole('combobox')).toHaveTextContent(generationTexts.roles.middle);
    await expect(inputRow(body, 4).getByRole('combobox')).toHaveTextContent(generationTexts.roles.last);
    await userEvent.click(inputRow(body, 4).getByRole('button', { name: generationTexts.remove({ name: generationTexts.input({ index: 4 }) }) }));
    await userEvent.click(inputRow(body, 3).getByRole('button', { name: generationTexts.remove({ name: generationTexts.input({ index: 3 }) }) }));
    await expect(body.getAllByRole('listitem')).toHaveLength(2);
    await expect(inputRow(body, 2).getByRole('combobox')).toHaveTextContent(generationTexts.roles.last);
    await fill(context, 'Сайт сервиса, одна опора');
    await waitFor(() => expect(body.getByRole('button', { name: manual.upload })).toBeEnabled());
    await userEvent.click(body.getByRole('button', { name: manual.upload }));
    await waitFor(() =>
      expect(screen.getByTestId('own-video-result')).toHaveTextContent(
        'story-video.mp4 · Сайт сервиса, одна опора · без стоимости · first:first, last:middle · Камера медленно наезжает'
      )
    );
  }
};

export const GenerationRoleError: Story = {
  name: 'Как сделано видео · «Последний кадр» не последним — загрузка недоступна с причиной',
  tags: ['ci'],
  parameters: { songframe: options(STORY_VIDEO_PATH, IMAGE_PATHS) },
  play: async (context) => {
    const screen = screenOf(context);
    const body = await addImages(context);
    await expect(await body.findAllByRole('listitem')).toHaveLength(3);
    await fill(context, 'Сайт сервиса');
    await waitFor(() => expect(body.getByRole('button', { name: manual.upload })).toBeEnabled());
    // Второй вход отмечают последним кадром, хотя за ним есть третий.
    await userEvent.click(inputRow(body, 2).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: generationTexts.roles.last }));
    await expect(await inputRow(body, 2).findByText(generationTexts.lastNotLast)).toBeVisible();
    const upload = body.getByRole('button', { name: manual.upload });
    await expect(upload).toBeDisabled();
    await userEvent.hover(upload.parentElement!);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(generationTexts.lastNotLast));
    // Выбранная вручную роль остаётся при перестановке: опустив вход в конец, ошибку снимают.
    await userEvent.click(inputRow(body, 2).getByRole('button', { name: generationTexts.moveDown({ name: generationTexts.input({ index: 2 }) }) }));
    await expect(inputRow(body, 3).getByRole('combobox')).toHaveTextContent(generationTexts.roles.last);
    await expect(inputRow(body, 2).getByRole('combobox')).toHaveTextContent(generationTexts.roles.middle);
    await expect(body.queryByText(generationTexts.lastNotLast)).not.toBeInTheDocument();
    await waitFor(() => expect(body.getByRole('button', { name: manual.upload })).toBeEnabled());
  }
};
