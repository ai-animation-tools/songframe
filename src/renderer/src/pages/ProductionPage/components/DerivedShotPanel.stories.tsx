import { useState, useSyncExternalStore, type ComponentProps, type ReactElement } from 'react';
import { Button, Stack, Typography } from '@mui/material';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { derivedShotTexts as panelTexts } from '@shared/texts/derived-shot';
import { derivedMainTexts as texts } from '@shared/texts/derived-shot-main';
import { createStoryApi } from '../../../testing/storybook';
import {
  createDerivedScenario,
  derivedPreview,
  DERIVED_ACCEPT_FAILURE,
  DERIVED_STORY_PROJECT,
  type DerivedScenarioCall,
  type DerivedScenarioOptions
} from '../../../testing/derivedStories';
import { DerivedShotPanel } from './DerivedShotPanel';

/** Журнал вызовов модели: Docs открывает каждую историю в своём iframe, поэтому общий модульный журнал не смешивает истории. */
function callLog() {
  let calls: readonly DerivedScenarioCall[] = [];
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((listener) => listener());
  return {
    reset(): void {
      calls = [];
      emit();
    },
    record(call: DerivedScenarioCall): void {
      calls = [...calls, call];
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: (): readonly DerivedScenarioCall[] => calls
  };
}
const calls = callLog();

function summary(builds: number, accepts: readonly string[]): string {
  return `Вызовы build: ${builds}. Вызовы accept: ${accepts.length}. Кандидаты приёмки: ${accepts.join(', ') || '—'}.`;
}
function callSummary(list: readonly DerivedScenarioCall[]): string {
  const accepts = list.flatMap((call) => (call.operation === 'accept' ? [`${call.id}${call.replace ? ' с заменой' : ''}`] : []));
  return summary(list.filter((call) => call.operation === 'build').length, accepts);
}

/** Каждый Canvas получает собственную модель и очистку; рабочий hook опрашивает её своим интервалом. */
function scenario(options: DerivedScenarioOptions = {}, log?: ReturnType<typeof callLog>) {
  return {
    songframe: {
      route: '/project/production?shot=M02',
      createApi: () => {
        log?.reset();
        const model = createDerivedScenario(log ? { ...options, onCall: log.record } : options);
        const session = createStoryApi(model.api);
        session.onCleanup(model.dispose);
        return session;
      }
    }
  };
}

/** Под панелью виден журнал вызовов: play проверяет отказ от приёмки при отмене и повтор без сборки. */
function CountedPanel(args: ComponentProps<typeof DerivedShotPanel>): ReactElement {
  const list = useSyncExternalStore(calls.subscribe, calls.get);
  return (
    <Stack spacing={2}>
      <DerivedShotPanel {...args} />
      <Typography variant="caption" color="text.secondary" data-testid="derived-calls">
        {callSummary(list)}
      </Typography>
    </Stack>
  );
}

function SwitchingPanel(args: ComponentProps<typeof DerivedShotPanel>): ReactElement {
  const [shot, setShot] = useState(args.shot);
  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        Выбран путь через ссылку. Ответ API содержит другой канонический путь: правки и подтверждение принадлежат выбранному плану.
      </Typography>
      <Button startIcon={<SwapHorizIcon />} onClick={() => setShot((current) => (current === 'M02' ? 'M03' : 'M02'))}>
        Переключить план · {shot}
      </Button>
      <DerivedShotPanel {...args} shot={shot} />
    </Stack>
  );
}

const meta = {
  title: 'Производство/Производный план/Панель',
  component: DerivedShotPanel,
  args: { project: DERIVED_STORY_PROJECT, shot: 'M02', onApplied: async () => {} },
  parameters: {
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Локальная модель API показывает состояния формы и заданий. Видео подготовлены заранее: источник содержит 150 кадров, пробы — 92 или 62 кадра при 30 FPS. Изменение рецепта проверяет взаимодействие, но не запускает настоящий монтаж выбранного участка.'
      }
    },
    ...scenario()
  }
} satisfies Meta<typeof DerivedShotPanel>;
export default meta;

type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];
const canvasOf = ({ canvasElement }: PlayContext) => within(canvasElement);
const screenOf = ({ canvasElement }: PlayContext) => within(canvasElement.ownerDocument.body);
const ACCEPT_TITLE = texts.acceptTitle({ shot: 'M02' });
// Запуск отвечает через 400 мс, задание завершается через 1100 мс, итог приходит следующим опросом раз в 1800 мс.
const JOB_TIMEOUT = { timeout: 6000 };

async function counted(context: PlayContext, builds: number, accepts: string[]): Promise<void> {
  await waitFor(() => expect(canvasOf(context).getByTestId('derived-calls')).toHaveTextContent(summary(builds, accepts)));
}

/** ActionButton перемонтирует кнопку при смене причины блокировки, поэтому кнопка ищется заново на каждой попытке. */
async function enabledButton(context: PlayContext, name: string): Promise<HTMLElement> {
  let button: HTMLElement | undefined;
  await waitFor(() => {
    button = canvasOf(context).getByRole('button', { name });
    expect(button).toBeEnabled();
  }, JOB_TIMEOUT);
  return button!;
}

async function replacementDialog(context: PlayContext) {
  await userEvent.click(await enabledButton(context, panelTexts.replace));
  const dialog = await screenOf(context).findByRole('dialog', { name: panelTexts.replaceTitle });
  // После появления Paper MUI ещё переводит фокус; Escape и клики ждут окончания перехода.
  await waitFor(() => expect(dialog).toBeVisible());
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await expect(within(dialog).getByText(panelTexts.replaceDescription({ shot: 'M02' }))).toBeInTheDocument();
  return within(dialog);
}

async function closed(context: PlayContext): Promise<void> {
  await waitFor(() => expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument());
}

/** Ответ запуска показывает только выполняющееся задание: кандидат ещё не принят и действие заблокировано. */
async function acceptRunning(context: PlayContext, name: string): Promise<void> {
  const canvas = canvasOf(context);
  await canvas.findByText(ACCEPT_TITLE, {}, JOB_TIMEOUT);
  await expect(canvas.queryByText(panelTexts.alreadyAccepted)).not.toBeInTheDocument();
  await expect(canvas.getByRole('button', { name })).toBeDisabled();
}

/** Итог приёмки приходит только с опросом после завершения задания; у принятого комплекта кнопка предлагает замену и выключена. */
async function acceptDone(context: PlayContext): Promise<void> {
  const canvas = canvasOf(context);
  await canvas.findByText(commonTexts.job.done({ title: ACCEPT_TITLE }), {}, JOB_TIMEOUT);
  await expect(canvas.getByText(panelTexts.alreadyAccepted)).toBeInTheDocument();
  await waitFor(() => expect(canvas.getByRole('button', { name: panelTexts.replace })).toBeDisabled());
}

export const SaveBuildAccept: Story = {
  name: 'Сохранить → собрать → проверить → принять',
  parameters: {
    ...scenario({ view: { recipe: null } }),
    docs: {
      description: {
        story:
          'Выберите способ и задайте кадры. Сохранение меняет рецепт; модель сборки возвращает выполняющееся задание. Через штатный опрос появится заранее подготовленная проба подходящей длины, которую нужно принять отдельным действием. Произвольный рецепт не исполняется. Приёмка тоже заканчивается через опрос, а не при получении Promise с running.'
      }
    }
  }
};
export const FreshCandidate: Story = { name: 'Свежий кандидат · приёмка через задание', parameters: scenario({ view: { preview: derivedPreview() } }) };
export const Replacement: Story = {
  name: 'Замена принятого комплекта · отмена и подтверждение',
  // Диалог переводит фокус и обрабатывает Escape: последовательность выполняется только в Canvas.
  tags: ['ci', '!autodocs'],
  render: (args) => <CountedPanel {...args} />,
  parameters: scenario({ view: { preview: derivedPreview(), hasAsset: true } }, calls),
  play: async (context) => {
    const canvas = canvasOf(context);
    // Отмена кнопкой и Escape закрывает подтверждение без вызова приёмки; кандидат остаётся непринятым.
    const cancelled = await replacementDialog(context);
    await userEvent.click(cancelled.getByRole('button', { name: commonTexts.cancel }));
    await closed(context);
    await counted(context, 0, []);
    await expect(canvas.queryByText(panelTexts.alreadyAccepted)).not.toBeInTheDocument();
    await replacementDialog(context);
    await userEvent.keyboard('{Escape}');
    await closed(context);
    await counted(context, 0, []);
    await expect(canvas.queryByText(panelTexts.alreadyAccepted)).not.toBeInTheDocument();
    await enabledButton(context, panelTexts.replace);
    // Подтверждение запускает задание приёмки с заменой; принятый результат виден только после опроса.
    const dialog = await replacementDialog(context);
    await userEvent.click(dialog.getByRole('button', { name: panelTexts.replace }));
    await closed(context);
    await counted(context, 0, ['preview-1 с заменой']);
    await acceptRunning(context, panelTexts.replace);
    await acceptDone(context);
    await counted(context, 0, ['preview-1 с заменой']);
  }
};
export const AcceptFailure: Story = {
  name: 'Сбой приёмки · кандидат сохранён для повтора',
  tags: ['ci', '!autodocs'],
  render: (args) => <CountedPanel {...args} />,
  parameters: {
    ...scenario({ view: { preview: derivedPreview() }, failAcceptOnce: true }, calls),
    docs: {
      description: {
        story:
          'Нажмите «Принять результат». Первое задание завершается ошибкой с сохранением кандидата и resultToken. Повторная приёмка того же кандидата завершается успешно без новой сборки.'
      }
    }
  },
  play: async (context) => {
    const canvas = canvasOf(context);
    // Первая приёмка: запуск отвечает running, ошибка задания приходит опросом, кандидат остаётся доступным.
    await userEvent.click(await enabledButton(context, panelTexts.accept));
    await counted(context, 0, ['preview-1']);
    await acceptRunning(context, panelTexts.accept);
    await canvas.findByText(DERIVED_ACCEPT_FAILURE, {}, JOB_TIMEOUT);
    await expect(canvas.getByText(panelTexts.preview)).toBeInTheDocument();
    await expect(canvas.queryByText(panelTexts.alreadyAccepted)).not.toBeInTheDocument();
    // Повтор принимает тот же кандидат без новой сборки; заголовок упавшего задания уходит вместе с ошибкой.
    await userEvent.click(await enabledButton(context, panelTexts.accept));
    await counted(context, 0, ['preview-1', 'preview-1']);
    await waitFor(() => expect(canvas.queryByText(DERIVED_ACCEPT_FAILURE)).not.toBeInTheDocument(), JOB_TIMEOUT);
    await acceptRunning(context, panelTexts.accept);
    await acceptDone(context);
    await counted(context, 0, ['preview-1', 'preview-1']);
  }
};
export const Loading: Story = { name: 'Длительная загрузка', parameters: scenario({ initialDelay: 30000 }) };
export const LoadFailure: Story = { name: 'Ошибка чтения · повтор и восстановление', parameters: scenario({ failLoadOnce: true }) };
export const NoRuntime: Story = {
  name: 'Нет Python и FFmpeg · рецепт можно сохранить',
  parameters: scenario({ view: { recipe: null, toolsProblem: texts.toolsUnavailable } })
};
export const MissingSource: Story = {
  name: 'Источник недоступен · сохранение остаётся доступным',
  parameters: scenario({ view: { recipe: null, sourcePath: null, sourceFrames: 0, problem: texts.sourceUnavailable } })
};
export const StaleSource: Story = {
  name: 'Источник устарел · принятый клип виден',
  parameters: scenario({ view: { problem: texts.sourceStale, preview: derivedPreview({ fresh: false, problem: texts.previewStale }) } })
};
export const LipSync: Story = { name: 'Липсинк блокирует монтаж', parameters: scenario({ view: { recipe: null, problem: texts.lipsyncUnsupported } }) };
export const ChangedSource: Story = {
  name: 'Материал источника изменился · пересборка',
  parameters: scenario({ view: { sourceTitle: 'Новая принятая версия источника', preview: derivedPreview({ fresh: false, problem: texts.previewStale }) } })
};
export const ChangedMetadata: Story = {
  name: 'Метаданные источника изменились · старая квитанция',
  parameters: {
    ...scenario({ view: { preview: derivedPreview({ fresh: false, problem: texts.previewStale }) } }),
    docs: {
      description: {
        story:
          'Клип по-прежнему доступен, но манифест источника изменился. Сохранённая квитанция не подтверждает текущие входы: просмотр доступен, приёмка заблокирована до пересборки.'
      }
    }
  }
};
export const ChangedMusic: Story = {
  name: 'Музыка изменилась · переслушать новую пробу',
  parameters: {
    ...scenario({ view: { preview: derivedPreview({ fresh: false, problem: texts.previewStale }) } }),
    docs: { description: { story: 'Сохранённая проба относится к предыдущему снимку музыки. Пересоберите, посмотрите результат и примите его отдельно.' } }
  }
};
export const SwitchShot: Story = {
  name: 'Смена плана · канонический путь API отличается',
  render: (args) => <SwitchingPanel {...args} />,
  parameters: scenario({ view: { preview: derivedPreview(), hasAsset: true } })
};
