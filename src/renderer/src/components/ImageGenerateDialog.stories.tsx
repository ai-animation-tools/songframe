/** Истории проходят подготовку и подтверждение через реальные кнопки общего диалога. */
import { useCallback, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Box, Stack, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { sourcesTexts } from '@shared/texts/sources';
import { commonTexts } from '@shared/texts/common';
import type { ImageGenerationResult } from '../hooks/useImageGeneration';
import {
  IMAGE_ATTACHMENT_ERROR,
  IMAGE_STORY_PATH,
  IMAGE_STORY_PROJECT,
  IMAGE_STORY_PROMPT,
  IMAGE_STORY_TARGET,
  imageStoryOptions
} from '../testing/imageStories';
import { ImageGenerateDialog } from './ImageGenerateDialog';
import { ActionButton } from './ActionButton';

function ImageStory({ mode = 'cover' }: { mode?: 'cover' | 'reference' }) {
  const [open, setOpen] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const onAccepted = useCallback(
    async (result: ImageGenerationResult): Promise<void> => {
      if (mode === 'reference') await window.api.referenceImages.attach(result.id, 'character-oleg');
      setAccepted(true);
    },
    [mode]
  );
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{mode === 'reference' ? IMAGE_STORY_TARGET : 'Обложка клипа «У старых ворот»'}</Typography>
      <Alert severity={accepted ? 'success' : 'info'}>
        {accepted
          ? mode === 'reference'
            ? 'Полный оригинал принят и добавлен к персонажу.'
            : 'Выбранная квадратная область принята в локальную форму.'
          : 'Сохранённое изображение остаётся прежним до явного принятия кандидата.'}
      </Alert>
      <Box
        component="img"
        src={window.api.shell.fileUrl(IMAGE_STORY_PATH)}
        alt="Сохранённое изображение"
        sx={{ width: 240, maxWidth: '100%', borderRadius: 1 }}
      />
      <Box>
        <ActionButton startIcon={<AutoAwesomeIcon />} onClick={() => setOpen(true)}>
          Открыть генерацию
        </ActionButton>
      </Box>
      {open && (
        <ImageGenerateDialog
          project={IMAGE_STORY_PROJECT}
          mode={mode}
          target={IMAGE_STORY_TARGET}
          initialPrompt={IMAGE_STORY_PROMPT}
          acceptedHint={mode === 'reference' ? 'Принимается весь оригинал; изображение добавится к персонажу без замены прежних референсов.' : undefined}
          onAccepted={onAccepted}
          onClose={() => setOpen(false)}
        />
      )}
    </Stack>
  );
}

const meta = {
  title: 'Общие компоненты/Генерация изображений',
  component: ImageStory,
  // Взаимодействия с фокусом проверяются в отдельном Canvas без массового play в Docs.
  tags: ['!autodocs'],
  args: { mode: 'cover' },
  render: (args) => <ImageStory key={args.mode} {...args} />,
  parameters: { songframe: imageStoryOptions() }
} satisfies Meta<typeof ImageStory>;
export default meta;
type Story = StoryObj<typeof meta>;

type PlayContext = Parameters<NonNullable<Story['play']>>[0];
const screenOf = ({ canvasElement }: PlayContext) => within(canvasElement.ownerDocument.body);

async function prepare(context: PlayContext): Promise<void> {
  const screen = screenOf(context);
  const label = context.args.mode === 'reference' ? sourcesTexts.generateReferenceImage : sourcesTexts.generateCover;
  const button = screen.getByRole('button', { name: label });
  await userEvent.click(button);
}

async function generate(context: PlayContext): Promise<void> {
  await prepare(context);
  const screen = screenOf(context);
  const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
  await userEvent.click(
    within(confirmation).getByRole('button', { name: context.args.mode === 'reference' ? sourcesTexts.generateReferenceImage : sourcesTexts.generateCover })
  );
}

async function candidate(context: PlayContext): Promise<void> {
  await generate(context);
  const screen = screenOf(context);
  const image = await screen.findByRole('img', { name: context.args.mode === 'reference' ? IMAGE_STORY_TARGET : sourcesTexts.createdCoverAlt });
  // При появлении изображения crop обложки устанавливается следующим эффектом; Docs-iframe может быть скрыт.
  await waitFor(() => {
    if (screen.getByRole<HTMLButtonElement>('button', { name: sourcesTexts.accept }).disabled) throw new Error('Кандидат ещё не готов к принятию.');
  });
  await expect(image).toBeInTheDocument();
  await expect(screen.getByRole('button', { name: sourcesTexts.accept })).toBeEnabled();
}

export const CoverPrompt: Story = { name: 'Обложка — редактируемый промпт' };
export const ProviderRequired: Story = {
  name: 'Провайдер не выбран',
  parameters: { songframe: imageStoryOptions({}, false) }
};
export const Preparation: Story = {
  name: 'Подготовка — закрытие без принятия',
  parameters: { songframe: imageStoryOptions({ preparePending: true }) },
  play: async (context) => {
    await prepare(context);
    await expect(screenOf(context).getByRole('status')).toBeInTheDocument();
  }
};
export const PreparationFailure: Story = {
  name: 'Ошибка подготовки — доступен повтор',
  parameters: { songframe: imageStoryOptions({ failPreparationOnce: true }) },
  play: async (context) => {
    await prepare(context);
    await expect(await screenOf(context).findByText('Не удалось подготовить запрос. Повторите подготовку.')).toBeInTheDocument();
  }
};
export const KnownPrice: Story = {
  name: 'Цена известна — новое согласование промпта',
  play: async (context) => {
    await prepare(context);
    const confirmation = await screenOf(context).findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
  }
};
export const UnknownPrice: Story = {
  tags: ['ci'],
  name: 'Цена неизвестна — отдельное согласие',
  parameters: { songframe: imageStoryOptions({ quote: 'unknown' }) },
  play: prepare
};
export const InsufficientBalance: Story = {
  name: 'Недостаточно средств — обновление цены',
  parameters: { songframe: imageStoryOptions({ quote: 'insufficient' }) },
  play: prepare
};
export const PromptConfirmation: Story = {
  name: 'Точное подтверждение подготовленного промпта',
  play: prepare
};
export const Generating: Story = {
  name: 'Ожидание изображения',
  parameters: { songframe: imageStoryOptions({ generating: true }) },
  play: generate
};
export const CoverCandidate: Story = {
  name: 'Кандидат обложки — квадрат и явное принятие',
  play: candidate
};
export const ReferenceCandidate: Story = {
  name: 'Референс — видимая сущность и полный оригинал',
  args: { mode: 'reference' },
  play: async (context) => {
    await candidate(context);
    await expect(screenOf(context).queryByRole('group', { name: sourcesTexts.cropArea })).not.toBeInTheDocument();
  }
};
export const GenerationFailure: Story = {
  name: 'Сбой генерации — новая попытка по действию',
  parameters: { songframe: imageStoryOptions({ failGenerationOnce: true }) },
  play: async (context) => {
    await generate(context);
    await expect(await screenOf(context).findByText('Генерация завершилась с ошибкой. Можно подготовить новую попытку.')).toBeInTheDocument();
  }
};
export const AttachmentRetry: Story = {
  tags: ['ci'],
  name: 'Ошибка привязки — повтор с тем же кандидатом',
  args: { mode: 'reference' },
  parameters: { songframe: imageStoryOptions({ failAttachmentOnce: true }) },
  play: async (context) => {
    await candidate(context);
    const screen = screenOf(context);
    await userEvent.click(screen.getByRole('button', { name: sourcesTexts.accept }));
    await expect(await screen.findByText(IMAGE_ATTACHMENT_ERROR)).toBeInTheDocument();
    await expect(screen.getByRole('button', { name: sourcesTexts.more })).toBeDisabled();
    await expect(screen.getByRole('button', { name: sourcesTexts.accept })).toBeEnabled();
  }
};
