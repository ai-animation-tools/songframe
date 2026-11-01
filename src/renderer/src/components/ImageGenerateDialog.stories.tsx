/** Истории проходят подготовку и подтверждение через реальные кнопки общего диалога. */
import { useCallback, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Box, Stack, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { sourcesTexts } from '@shared/texts/sources';
import { commonTexts } from '@shared/texts/common';
import { referenceImagePrompt } from '@shared/reference-image-generation';
import type { ImageGenerationResult } from '../hooks/useImageGeneration';
import {
  completeImageStoryCreate,
  IMAGE_ATTACHMENT_ERROR,
  IMAGE_STORY_INPUT,
  IMAGE_STORY_IDEA,
  IMAGE_STORY_LYRICS,
  IMAGE_STORY_STYLE,
  IMAGE_STORY_PATH,
  IMAGE_STORY_PROJECT,
  IMAGE_STORY_PROMPT,
  IMAGE_STORY_TARGET,
  imageStoryInspection,
  imageStoryOptions
} from '../testing/imageStories';
import { ImageGenerateDialog } from './ImageGenerateDialog';
import { ActionButton } from './ActionButton';

function ImageStory({
  mode = 'cover',
  withReferences = true,
  duplicateReference = false,
  notesFixture = false
}: {
  mode?: 'cover' | 'reference';
  withReferences?: boolean;
  duplicateReference?: boolean;
  notesFixture?: boolean;
}) {
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
          initialPrompt={mode === 'reference' ? referenceImagePrompt({ name: IMAGE_STORY_TARGET }) : IMAGE_STORY_PROMPT}
          referenceDescription={mode === 'reference' ? 'Красная куртка, тёмные волосы.' : undefined}
          referenceInput={
            mode === 'reference'
              ? {
                  ...IMAGE_STORY_INPUT,
                  images: !withReferences
                    ? []
                    : notesFixture
                      ? [
                          { ...IMAGE_STORY_INPUT.images[0], note: 'Сохранить лицо' },
                          { ...IMAGE_STORY_INPUT.images[0], label: 'В полный рост', note: 'Сохранить силуэт' },
                          { path: '/mock/second-story-image.png', label: 'Сбоку', note: 'Сохранить куртку' },
                          { path: '/mock/empty-note-story-image.png', label: 'Сзади', note: '  ' }
                        ]
                      : duplicateReference
                        ? [...IMAGE_STORY_INPUT.images, { ...IMAGE_STORY_INPUT.images[0], label: 'Тот же герой — дополнительная подпись' }]
                        : IMAGE_STORY_INPUT.images
                }
              : undefined
          }
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

/** Раскрытие блоков меняет только компоновку; подготовка запроса остаётся отдельным действием. */
async function expandReferenceSection(screen: ReturnType<typeof screenOf>, label: string): Promise<void> {
  const summary = screen.getByRole('button', { name: (name) => name.startsWith(label) });
  if (summary.getAttribute('aria-expanded') !== 'true') await userEvent.click(summary);
}

async function prepare(context: PlayContext): Promise<void> {
  const screen = screenOf(context);
  const label = context.args.mode === 'reference' ? sourcesTexts.generateReferenceImage : sourcesTexts.generateCover;
  // После подготовки цена становится частью доступного имени той же кнопки генерации.
  const button = () => screen.getByRole<HTMLButtonElement>('button', { name: (name) => name === label || name.startsWith(`${label} · `) });
  // При завершении чтения Tooltip меняет обёртку недоступной кнопки: перечитываем актуальный узел.
  await waitFor(() => {
    if (button().disabled) throw new Error('Подготовка ещё недоступна.');
  });
  await userEvent.click(button());
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

export const CoverPrompt: Story = {
  tags: ['ci'],
  name: 'Обложка — редактируемый промпт без опор референса',
  play: async (context) => {
    await prepare(context);
    const confirmation = await screenOf(context).findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole('textbox', { name: sourcesTexts.confirmedPrompt })).toHaveValue(IMAGE_STORY_PROMPT);
    await expect(within(confirmation).queryByRole('region', { name: sourcesTexts.referenceSupports })).not.toBeInTheDocument();
    await expect(imageStoryInspection()).toMatchObject({ creates: [{ mode: 'cover', prompt: IMAGE_STORY_PROMPT }], generations: 0 });
    await expect(imageStoryInspection().creates[0].input).toBeUndefined();
  }
};
export const ReferenceComposer: Story = {
  tags: ['ci'],
  name: 'Референс — свёрнутые блоки, опоры и описание по умолчанию',
  args: { mode: 'reference' },
  play: async (context) => {
    const screen = screenOf(context);
    for (const label of [sourcesTexts.referenceSupports, sourcesTexts.referenceConstructor])
      await expect(screen.getByRole('button', { name: (name) => name.startsWith(label) })).toHaveAttribute('aria-expanded', 'false');
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await waitFor(() => expect(prompt).toBeVisible());
    await expect(prompt.value).toContain('Красная куртка, тёмные волосы.');
    await expect(prompt.value).not.toContain(IMAGE_STORY_STYLE);
    const before = prompt.value;
    const summary = screen.getByRole('button', { name: (name) => name.startsWith(sourcesTexts.referenceConstructor) });
    summary.focus();
    await userEvent.keyboard('{Enter}');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => {
      if (screen.getByRole<HTMLInputElement>('checkbox', { name: sourcesTexts.referenceVisualStyle }).disabled) throw new Error('Контекст ещё читается.');
    });
    for (const label of [sourcesTexts.referenceClipName, sourcesTexts.referenceLyrics, sourcesTexts.referenceIdea, sourcesTexts.referenceVisualStyle])
      await expect(screen.getByRole('checkbox', { name: label })).not.toBeChecked();
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceDescription })).toBeChecked();
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceSupportNotes })).not.toBeChecked();
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle })).toHaveAccessibleName('Общие визуальные правила');
    await expandReferenceSection(screen, sourcesTexts.referenceSupports);
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: IMAGE_STORY_INPUT.images[0].label }) })).toBeChecked();
    await expect(prompt).toHaveValue(before);
    await expect(imageStoryInspection().creates).toHaveLength(0);
    const dialog = screen.getByRole('dialog', { name: sourcesTexts.createReferenceImage });
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.cancel }));
    await userEvent.click(await screen.findByRole('button', { name: 'Открыть генерацию' }));
    for (const label of [sourcesTexts.referenceSupports, sourcesTexts.referenceConstructor])
      await expect(screen.getByRole('button', { name: (name) => name.startsWith(label) })).toHaveAttribute('aria-expanded', 'false');
  }
};
export const ReferenceContextAndSupports: Story = {
  tags: ['ci'],
  name: 'Референс — выбор контекста и точный ручной промпт',
  args: { mode: 'reference' },
  play: async (context) => {
    const screen = screenOf(context);
    await expandReferenceSection(screen, sourcesTexts.referenceConstructor);
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await waitFor(() => {
      if (screen.getByRole<HTMLInputElement>('checkbox', { name: sourcesTexts.referenceVisualStyle }).disabled) throw new Error('Контекст ещё читается.');
    });
    for (const label of [sourcesTexts.referenceClipName, sourcesTexts.referenceIdea, sourcesTexts.referenceLyrics])
      await expect(screen.getByRole('checkbox', { name: label })).not.toBeChecked();
    await expect(prompt.value).not.toContain(IMAGE_STORY_IDEA);
    await expect(prompt.value).not.toContain(IMAGE_STORY_LYRICS);
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceDescription })).toBeChecked();
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle })).not.toBeChecked();
    await expect(prompt.value).not.toContain(IMAGE_STORY_STYLE);
    for (const label of [sourcesTexts.referenceClipName, sourcesTexts.referenceIdea, sourcesTexts.referenceLyrics, sourcesTexts.referenceVisualStyle])
      await userEvent.click(screen.getByRole('checkbox', { name: label }));
    await expect(prompt.value).toContain('У старых ворот');
    await expect(prompt.value).toContain(IMAGE_STORY_IDEA);
    await expect(prompt.value).toContain(IMAGE_STORY_LYRICS);
    const edited = '  Только профиль героя.\nБез нового окружения.  ';
    await userEvent.clear(prompt);
    await userEvent.type(prompt, edited);
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle })).toBeDisabled();
    await expect(screen.getByText(sourcesTexts.referenceCharacterCount({ count: edited.length }))).toBeInTheDocument();
    await prepare(context);
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole('textbox', { name: sourcesTexts.confirmedPrompt })).toHaveValue(edited);
    const inspection = imageStoryInspection();
    await expect(inspection.creates[0]).toMatchObject({ prompt: edited, input: IMAGE_STORY_INPUT });
    await expect(inspection.creates[0].input?.images[0]).not.toHaveProperty('note');
    await expect(inspection.generations).toBe(0);
    await expect(inspection.sessions[0].referenceImages?.[0].path).toContain('/private-session/');
    await expect(within(confirmation).getByRole('img', { name: IMAGE_STORY_INPUT.images[0].label })).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    const field = await screen.findByRole('textbox', { name: sourcesTexts.referenceImagePrompt });
    await expect(field).not.toHaveAttribute('readonly');
    // Сворачивание и раскрытие после подготовки не меняет снимок запроса и его согласование.
    await userEvent.click(screen.getByRole('button', { name: (name) => name.startsWith(sourcesTexts.referenceConstructor) }));
    await expandReferenceSection(screen, sourcesTexts.referenceConstructor);
    await expect(field).toHaveValue(edited);
    await expect(imageStoryInspection().closes).toHaveLength(0);
    await prepare(context);
    await expect(imageStoryInspection().creates).toHaveLength(1);
    await expect(imageStoryInspection().generations).toBe(0);
  }
};
/** Копии одного изображения имеют единый номер; текст выключенных и исключённых примечаний не уходит скрыто. */
export const ReferenceSupportNotes: Story = {
  tags: ['ci'],
  name: 'Примечания опор — явный выбор, копии и окончательный ручной текст',
  args: { mode: 'reference', notesFixture: true },
  play: async (context) => {
    const screen = screenOf(context);
    await expandReferenceSection(screen, sourcesTexts.referenceConstructor);
    await expandReferenceSection(screen, sourcesTexts.referenceSupports);
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    const toggle = () => screen.getByRole('checkbox', { name: sourcesTexts.referenceSupportNotes });
    await waitFor(() => expect(toggle()).toBeEnabled());
    await expect(toggle()).not.toBeChecked();
    await expect(prompt.value).not.toContain('Сохранить лицо');
    await expect(prompt.value).not.toContain('Сохранить куртку');
    await userEvent.click(toggle());
    await expect(prompt.value).toContain('Опора 1 (Спереди · В полный рост):\nСохранить лицо\nСохранить силуэт');
    await expect(prompt.value).toContain('Опора 2 (Сбоку):\nСохранить куртку');
    await expect(prompt.value).not.toContain('Опора 3');
    await userEvent.click(screen.getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: 'В полный рост' }) }));
    await waitFor(() => expect(prompt.value).not.toContain('Сохранить силуэт'));
    await userEvent.click(screen.getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: 'Спереди' }) }));
    await waitFor(() => expect(prompt.value).toContain('Опора 1 (Сбоку):\nСохранить куртку'));
    await expect(prompt.value).not.toContain('Сохранить лицо');
    const visible = prompt.value;
    await prepare(context);
    let confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole('textbox', { name: sourcesTexts.confirmedPrompt })).toHaveValue(visible);
    await expect(imageStoryInspection().sessions[0].referenceImages).toHaveLength(2);
    for (const input of imageStoryInspection().creates[0].input?.images ?? []) {
      await expect(input).not.toHaveProperty('note');
      await expect(input.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(input.label).not.toContain('Сохранить');
    }
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    const manual = '  Только мой текст.\nСохранить лицо по выбранной картинке.  ';
    await userEvent.clear(prompt);
    await userEvent.type(prompt, manual);
    await expect(toggle()).toBeDisabled();
    await prepare(context);
    confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole('textbox', { name: sourcesTexts.confirmedPrompt })).toHaveValue(manual);
    await expect(imageStoryInspection().creates.at(-1)?.prompt).toBe(manual);
    await expect(imageStoryInspection().generations).toBe(0);
  }
};

export const ReferenceSupportReadFailure: Story = {
  tags: ['ci'],
  name: 'Примечания опор — ошибка чтения и явный повтор',
  args: { mode: 'reference', notesFixture: true },
  parameters: { songframe: imageStoryOptions({ failInspectOnce: true }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText('Не удалось прочитать опорные изображения. Проверьте файлы объекта.')).toBeVisible();
    await expandReferenceSection(screen, sourcesTexts.referenceSupports);
    await expect(screen.queryByText(sourcesTexts.referenceNoSelectedImages)).not.toBeInTheDocument();
    await expandReferenceSection(screen, sourcesTexts.referenceConstructor);
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Мой ручной промпт не обходит проверку опор.');
    await expect(screen.getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeDisabled();
    await expect(imageStoryInspection().creates).toHaveLength(0);
    const error = screen.getAllByRole('alert').find((alert) => alert.textContent?.includes('Не удалось прочитать опорные изображения.'));
    if (!error) throw new Error('Нет сообщения об ошибке чтения опор.');
    await userEvent.click(within(error).getByRole('button', { name: sourcesTexts.referenceSupportsRetry }));
    await prepare(context);
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole('textbox', { name: sourcesTexts.confirmedPrompt })).toHaveValue('Мой ручной промпт не обходит проверку опор.');
    await expect(imageStoryInspection().generations).toBe(0);
  }
};

export const ReferenceEditedAfterPreparation: Story = {
  tags: ['ci'],
  name: 'Референс — правка сбрасывает подготовку, цену и выбранные опоры',
  args: { mode: 'reference' },
  play: async (context) => {
    const screen = screenOf(context);
    await prepare(context);
    let confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    const oldSession = imageStoryInspection().sessions[0];
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    const prompt = await screen.findByRole('textbox', { name: sourcesTexts.referenceImagePrompt });
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Герой без опор, общий план.');
    await expandReferenceSection(screen, sourcesTexts.referenceSupports);
    await userEvent.click(screen.getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: IMAGE_STORY_INPUT.images[0].label }) }));
    await expect(screen.getByRole('button', { name: sourcesTexts.accept })).toBeDisabled();
    await expect(imageStoryInspection().closes).toContain(oldSession.id);
    await expect(imageStoryInspection().sessions).toHaveLength(0);
    await prepare(context);
    confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    const inspection = imageStoryInspection();
    await expect(inspection.creates).toHaveLength(2);
    await expect(inspection.creates[1]).toMatchObject({ prompt: 'Герой без опор, общий план.', input: { images: [] } });
    await expect(inspection.sessions[0].approvalToken).not.toBe(oldSession.approvalToken);
    await expect(inspection.sessions[0].requestSha).not.toBe(oldSession.requestSha);
    await expect(within(confirmation).queryAllByRole('img')).toHaveLength(0);
    await expect(inspection.generations).toBe(0);
  }
};
export const ReferenceUnknownPriceEdit: Story = {
  tags: ['ci'],
  name: 'Референс — прежнее согласие с неизвестной ценой не переносится на правку',
  args: { mode: 'reference' },
  parameters: { songframe: imageStoryOptions({ quote: 'unknown' }) },
  play: async (context) => {
    const screen = screenOf(context);
    await prepare(context);
    await userEvent.click(await screen.findByRole('button', { name: sourcesTexts.agree }));
    await prepare(context);
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    const prompt = await screen.findByRole('textbox', { name: sourcesTexts.referenceImagePrompt });
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Новая короткая постановка.');
    await prepare(context);
    await expect(screen.queryByRole('dialog', { name: sourcesTexts.confirmPromptTitle })).not.toBeInTheDocument();
    await expect(screen.getByRole('button', { name: sourcesTexts.agree })).toBeEnabled();
    await expect(screen.getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeDisabled();
    await expect(imageStoryInspection().creates).toHaveLength(2);
    await expect(imageStoryInspection().generations).toBe(0);
  }
};
export const ReferenceRebuildPrompt: Story = {
  tags: ['ci'],
  name: 'Референс — ручной текст сохраняется до явной пересборки',
  args: { mode: 'reference' },
  play: async (context) => {
    const screen = screenOf(context);
    await expandReferenceSection(screen, sourcesTexts.referenceConstructor);
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await waitFor(() => {
      if (screen.getByRole<HTMLInputElement>('checkbox', { name: sourcesTexts.referenceVisualStyle }).disabled) throw new Error('Контекст ещё читается.');
    });
    await userEvent.click(screen.getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle }));
    await expect(prompt.value).toContain('Общие визуальные правила:');
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Мой короткий промпт.');
    await userEvent.click(screen.getByRole('button', { name: sourcesTexts.referenceRebuild }));
    let confirmation = await screen.findByRole('dialog', { name: sourcesTexts.referenceRebuildTitle });
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    await expect(await screen.findByRole('textbox', { name: sourcesTexts.referenceImagePrompt })).toHaveValue('Мой короткий промпт.');
    await userEvent.click(screen.getByRole('button', { name: sourcesTexts.referenceRebuild }));
    confirmation = await screen.findByRole('dialog', { name: sourcesTexts.referenceRebuildTitle });
    await userEvent.click(within(confirmation).getByRole('button', { name: sourcesTexts.referenceRebuild }));
    const rebuilt = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await expect(rebuilt.value).toContain(IMAGE_STORY_STYLE);
    await expect(screen.getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle })).toBeEnabled();
    await expect(imageStoryInspection().creates).toHaveLength(0);
  }
};
export const ReferenceContextReadFailure: Story = {
  tags: ['ci'],
  name: 'Референс — ошибка контекста допускает ручной запрос',
  args: { mode: 'reference' },
  parameters: { songframe: imageStoryOptions({ failContextOnce: true }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(/Не удалось прочитать контекст клипа\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: sourcesTexts.referenceWithoutContext }));
    const prompt = screen.getByRole('textbox', { name: sourcesTexts.referenceImagePrompt });
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Короткое описание без контекста.');
    await prepare(context);
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole('textbox', { name: sourcesTexts.confirmedPrompt })).toHaveValue('Короткое описание без контекста.');
    await expect(imageStoryInspection().generations).toBe(0);
  }
};
export const ReferenceLongStyle: Story = {
  tags: ['ci'],
  name: 'Референс — общие визуальные правила добавляются только по выбору',
  args: { mode: 'reference' },
  parameters: { songframe: imageStoryOptions({ longContext: true }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expandReferenceSection(screen, sourcesTexts.referenceConstructor);
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await waitFor(() => {
      if (screen.getByRole<HTMLInputElement>('checkbox', { name: sourcesTexts.referenceVisualStyle }).disabled) throw new Error('Контекст ещё читается.');
    });
    await expect(prompt.value).not.toContain(IMAGE_STORY_STYLE);
    await userEvent.click(screen.getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle }));
    await expect(prompt.value).toContain(`80. ${IMAGE_STORY_STYLE}`);
    await expect(prompt.value).toContain('Общие визуальные правила:');
    await userEvent.click(screen.getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle }));
    await expect(prompt.value).not.toContain(`80. ${IMAGE_STORY_STYLE}`);
    await expect(prompt.value.length).toBeLessThan(400);
  }
};
export const ReferenceGalleryDuringSnapshot: Story = {
  tags: ['ci'],
  name: 'Референс — открытая вторая опора при дедупликации снимка',
  args: { mode: 'reference', duplicateReference: true },
  parameters: { songframe: imageStoryOptions({ delayCreate: true }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expandReferenceSection(screen, sourcesTexts.referenceSupports);
    await prepare(context);
    await expect(screen.getByRole('status')).toBeInTheDocument();
    const supports = within(screen.getByRole('dialog', { name: sourcesTexts.createReferenceImage }));
    await expect(supports.getAllByRole('img')).toHaveLength(2);
    await userEvent.click(supports.getAllByRole('img')[1].closest('button')!);
    const gallery = await screen.findByRole('dialog', { name: /Тот же герой — дополнительная подпись/ });
    await expect(within(gallery).getByRole('img', { name: 'Тот же герой — дополнительная подпись' })).toBeInTheDocument();
    completeImageStoryCreate();
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(screen.queryByRole('dialog', { name: /Тот же герой — дополнительная подпись/ })).not.toBeInTheDocument();
    const images = within(confirmation).getAllByRole('img');
    await expect(images).toHaveLength(1);
    await expect(images[0]).toHaveAttribute('alt', `${IMAGE_STORY_INPUT.images[0].label} · Тот же герой — дополнительная подпись`);
    await expect(imageStoryInspection().sessions[0].referenceImages).toHaveLength(1);
    await expect(imageStoryInspection().generations).toBe(0);
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    await userEvent.click(within(dialog).getAllByRole('img')[0].closest('button')!);
    await expect(await screen.findByRole('dialog', { name: new RegExp(IMAGE_STORY_INPUT.images[0].label) })).toBeInTheDocument();
  }
};
export const ReferenceWithoutSupports: Story = {
  tags: ['ci'],
  name: 'Референс — описание без опор и общих правил',
  args: { mode: 'reference', withReferences: false },
  play: async (context) => {
    await expandReferenceSection(screenOf(context), sourcesTexts.referenceSupports);
    await expect(screenOf(context).getByText(sourcesTexts.referenceSupportsEmpty)).toBeInTheDocument();
    await prepare(context);
    const confirmation = await screenOf(context).findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.confirmedPrompt }).value).not.toContain(IMAGE_STORY_STYLE);
    await expect(within(confirmation).queryByRole('region', { name: sourcesTexts.referenceSupports })?.querySelectorAll('img')).toHaveLength(0);
    await expect(imageStoryInspection().creates[0].input?.images).toEqual([]);
  }
};
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
  tags: ['ci'],
  args: { mode: 'reference' },
  name: 'Ошибка подготовки — доступен повтор',
  parameters: { songframe: imageStoryOptions({ failPreparationOnce: true }) },
  play: async (context) => {
    await prepare(context);
    const screen = screenOf(context);
    await expect(await screen.findByText('Не удалось подготовить запрос. Повторите подготовку.')).toBeInTheDocument();
    await expect(await screen.findByRole('textbox', { name: sourcesTexts.referenceImagePrompt })).not.toHaveAttribute('readonly');
    await expect(imageStoryInspection().generations).toBe(0);
    await prepare(context);
    await expect(await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle })).toBeInTheDocument();
    await expect(imageStoryInspection().creates).toHaveLength(1);
    await expect(imageStoryInspection().generations).toBe(0);
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
export const ReferenceCandidateEdit: Story = {
  tags: ['ci'],
  name: 'Референс — прежний кандидат нельзя принять после правки запроса',
  args: { mode: 'reference' },
  play: async (context) => {
    await candidate(context);
    const screen = screenOf(context);
    const oldSession = imageStoryInspection().sessions[0];
    await expandReferenceSection(screen, sourcesTexts.referenceSupports);
    await userEvent.click(screen.getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: IMAGE_STORY_INPUT.images[0].label }) }));
    await expect(screen.getByRole('button', { name: sourcesTexts.accept })).toBeDisabled();
    await expect(screen.queryByRole('img', { name: IMAGE_STORY_TARGET })).not.toBeInTheDocument();
    await expect(imageStoryInspection().closes).toContain(oldSession.id);
    await prepare(context);
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole('textbox', { name: sourcesTexts.confirmedPrompt })).toHaveValue(oldSession.prompt);
    await expect(imageStoryInspection().creates[1].input?.images).toEqual([]);
    await expect(imageStoryInspection().generations).toBe(1);
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

export const MissingReferenceImageInspection: Story = {
  tags: ['ci'],
  name: 'Прежний API опор — отсутствие метода не скрывает диалог',
  args: { mode: 'reference' },
  parameters: { songframe: imageStoryOptions({ missingReferenceImageInspection: true }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(typeof window.api.referenceImages.inspect).toBe('undefined');
    let dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    await expect(await within(dialog).findByText(sourcesTexts.referenceSupportsRestartRequired)).toBeVisible();
    await expect(within(dialog).getByRole('textbox', { name: sourcesTexts.referenceImagePrompt })).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeDisabled();
    await expect(within(dialog).queryByRole('button', { name: sourcesTexts.referenceSupportsRetry })).not.toBeInTheDocument();
    await expandReferenceSection(within(dialog), sourcesTexts.referenceSupports);
    await expect(within(dialog).getByRole('button', { name: sourcesTexts.referenceSupportsRetry })).toBeDisabled();
    await expect(imageStoryInspection()).toMatchObject({ creates: [], generations: 0, sessions: [] });
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.cancel }));
    await expect(screen.queryByRole('dialog', { name: sourcesTexts.createReferenceImage })).not.toBeInTheDocument();
    await expect(screen.getByRole('img', { name: 'Сохранённое изображение' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Открыть генерацию' }));
    dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    await expect(await within(dialog).findByText(sourcesTexts.referenceSupportsRestartRequired)).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeDisabled();
    await expect(imageStoryInspection()).toMatchObject({ creates: [], generations: 0, sessions: [] });
  }
};
