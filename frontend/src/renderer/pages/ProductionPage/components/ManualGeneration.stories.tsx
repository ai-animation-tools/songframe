/** Ручная генерация речевого плана у провайдера без липсинка: сборка пакета, инструкция провайдера и загрузка видео. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { registerMediaProviderForTests } from '@shared/media-providers';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import { productionTexts } from '@shared/texts/production';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import type { PackageView } from '@shared/types';
import { DELIVERY_PROJECT, deliveryPackage } from '../../../testing/deliveryStories';
import { createStoryApi, STORY_VIDEO_PATH, type StoryOptions } from '../../../testing/storybook';
import { ManualGeneration, ManualGenerationInfo } from './ManualGeneration';

const texts = productionTexts.manualGeneration;
/** Адреса, переданные в браузер ОС: ссылка инструкции открывается через shell.openExternal, а не переходом WebView. */
const openedUrls = fn();
const PROMPT =
  'Один непрерывный средний план спереди в три четверти. Изображение задаёт внешность молодого блондина; движения губ точно совпадают с исполнением в аудио.';
const base = deliveryPackage('video', 'prepared');
const requestDir = `${base.dir}/request-01`;

/** Попытка речевого плана до сборки пакета: опора и промпт утверждены, срез речи готов. */
const ready: PackageView = {
  ...base,
  stage: 'prompt_review',
  pendingDecision: null,
  decision: { stage: 'prompt_review', verdict: 'approve' },
  keyframes: base.keyframes.filter((frame) => frame.role === 'first'),
  request: null,
  speech: { path: `${base.dir}/audio/speech.wav`, recipe: `${base.dir}/audio/audio-recipe.json`, start: 23.27, end: 28.27, lines: [] }
};

/** Собранный пакет ручной генерации: копии опоры и среза, замороженный промпт, ожидание видео. */
const built: PackageView = {
  ...ready,
  stage: 'request_choice',
  request: {
    dir: requestDir,
    kind: 'video',
    provider: TEST_PROVIDER,
    mode: 'manual',
    sha256: 'a'.repeat(64),
    model: '',
    parameters: { duration: 5 },
    inputs: [
      { slot: 'image', role: 'Опора K01', path: 'inputs/01.png', imagePath: `${requestDir}/inputs/01.png` },
      { slot: 'audio', role: 'Срез речи', path: 'inputs/02.wav', imagePath: `${requestDir}/inputs/02.wav` }
    ],
    attemptStatus: 'manual_pending',
    promptText: PROMPT,
    generationId: null,
    manualResult: false,
    creditsConsumed: null,
    downloads: []
  }
};

const view = (overrides: Partial<ProductionWorkflowView> = {}): ProductionWorkflowView =>
  ({
    project: DELIVERY_PROJECT,
    shot: base.shot,
    packageDir: base.dir,
    busy: false,
    stage: 'prompt_review',
    canPrepare: false,
    canContinue: false,
    canRevise: true,
    canGenerateFrames: false,
    paid: false,
    reasons: { prepare: null, continue: null, frames: null },
    derivedFrom: null,
    videoProvider: TEST_PROVIDER,
    framePrompts: [],
    nextFrame: null,
    approvedFrameIds: ['K01'],
    problems: [],
    proposal: null,
    job: null,
    manual: true,
    canBuildManual: true,
    ...overrides
  }) as ProductionWorkflowView;

/** Тестовый провайдер без липсинка с пошаговой инструкцией; выбор файла возвращает видео витрины. */
function manualOptions(): StoryOptions {
  return {
    createApi: () => {
      const session = createStoryApi({
        dialog: { pickFiles: async () => [STORY_VIDEO_PATH] },
        shell: { openPath: async () => undefined, openExternal: async (url) => void openedUrls(url) }
      });
      session.onCleanup(
        registerMediaProviderForTests(TEST_PROVIDER, {
          ...testProviderInfo,
          lipSync: null,
          manualLipSync: {
            url: 'https://example.test/avatar',
            steps: ['Откройте сайт {url} и выберите режим с липсинком.', 'Загрузите изображение {image} и звук {audio}.', 'Вставьте видеопромпт.'],
            sourceExample: 'Тестовый сервис на сайте'
          }
        })
      );
      return session;
    }
  };
}

const meta = {
  title: 'Производство/Пакет/Ручная генерация',
  component: ManualGeneration,
  tags: ['!autodocs'],
  args: { pkg: ready, view: view(), busy: false, onBuild: fn(), onAttach: fn() },
  parameters: { controls: { disable: true }, songframe: manualOptions() }
} satisfies Meta<typeof ManualGeneration>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Build: Story = {
  name: 'Пакет ещё не собран · сборка без агента',
  tags: ['ci'],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(texts.description);
    // Шаг «Речь» к этому моменту свёрнут: срез прослушивается здесь, до сборки пакета.
    const ready = productionTexts.productionSpeechPanel.ready({ start: '0:23.27', end: '0:28.27', seconds: productionTexts.productionSpeechPanel.seconds(5) });
    await canvas.findByText(ready);
    await expect(canvasElement.querySelector('audio')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: texts.build }));
    await waitFor(() => expect(args.onBuild).toHaveBeenCalledTimes(1));
  }
};

export const BuildBlocked: Story = {
  name: 'Сборка недоступна · причина в подсказке',
  args: { view: view({ canBuildManual: false, reasons: { prepare: null, continue: null, frames: null, manual: 'Сначала подготовьте WAV в блоке «Речь».' } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: texts.build })).toBeDisabled();
  }
};

export const Upload: Story = {
  name: 'Пакет собран · инструкция и загрузка видео',
  tags: ['ci'],
  args: { pkg: built, view: view({ stage: 'request_choice', canBuildManual: false }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(texts.built);
    await expect(canvasElement.querySelector('audio')).not.toBeNull();
    await canvas.findByText(texts.input({ role: 'Опора K01', name: '01.png' }));
    await canvas.findByText(texts.speechInput({ role: 'Срез речи', name: '02.wav', seconds: productionTexts.productionSpeechPanel.seconds(5) }));
    await canvas.findByText(texts.instruction({ provider: testProviderInfo.title }));
    const link = canvas.getByRole('link', { name: 'https://example.test/avatar' });
    await expect(link).toHaveAttribute('href', 'https://example.test/avatar');
    openedUrls.mockClear();
    await userEvent.click(link);
    await waitFor(() => expect(openedUrls).toHaveBeenCalledWith('https://example.test/avatar'));
    await canvas.findByText('Загрузите изображение 01.png и звук 02.wav.');
    // Выключенная кнопка обёрнута подсказкой причины: после включения это другой элемент, поэтому кнопка ищется заново.
    const upload = () => canvas.getByRole('button', { name: texts.upload });
    await expect(upload()).toBeDisabled();
    // Выбор файла, затем обязательный источник; стоимость и примечание необязательны.
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(texts.zone) }));
    // Выбор виден сразу: зона сменяется зелёной плашкой с именем файла и заменой.
    const chosen = await canvas.findByText(texts.chosen({ name: 'story-video.mp4' }));
    await expect(chosen.closest('[role="alert"]')).not.toBeNull();
    await expect(canvas.getByRole('button', { name: texts.replace })).toBeEnabled();
    await expect(canvas.queryByRole('button', { name: new RegExp(texts.zone) })).not.toBeInTheDocument();
    await expect(upload()).toBeDisabled();
    await userEvent.type(canvas.getByRole('textbox', { name: new RegExp(texts.source) }), 'Тестовый сервис на сайте');
    await userEvent.type(canvas.getByRole('textbox', { name: texts.cost }), '-1');
    await expect(upload()).toBeDisabled();
    await userEvent.clear(canvas.getByRole('textbox', { name: texts.cost }));
    await userEvent.type(canvas.getByRole('textbox', { name: texts.cost }), '75');
    await userEvent.type(canvas.getByRole('textbox', { name: texts.note }), 'Вторая попытка');
    await waitFor(() => expect(upload()).toBeEnabled());
    await userEvent.click(upload());
    await waitFor(() =>
      expect(args.onAttach).toHaveBeenCalledWith({
        file: STORY_VIDEO_PATH,
        source: 'Тестовый сервис на сайте',
        costAmount: 75,
        costUnit: 'credits',
        note: 'Вторая попытка'
      })
    );
  }
};

export const Uploaded: Story = {
  name: 'Видео загружено · сведения на шаге результата',
  render: () => (
    <ManualGenerationInfo
      record={{
        source: 'Тестовый сервис на сайте',
        original_name: 'avatar_0.mp4',
        attached_at: '2026-11-12T11:05:00Z',
        cost: { amount: 75, unit: 'credits' },
        description: 'Вторая попытка: промпт сокращён.'
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/Источник: Тестовый сервис на сайте · Стоимость: 75 кредитов/);
    await canvas.findByText('Вторая попытка: промпт сокращён.');
  }
};
