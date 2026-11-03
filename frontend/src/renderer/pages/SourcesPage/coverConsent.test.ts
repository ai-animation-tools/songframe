import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CoverGenerationSession } from '@shared/cover-generation';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { CoverCropEditor } from '../../components/CoverCropEditor';
import { ImageGenerateDialog } from '../../components/ImageGenerateDialog';
import { ConfirmationDialog } from '../../components/ConfirmationDialog';

const fixture = vi.hoisted(() => ({
  session: null as CoverGenerationSession | null,
  contextReady: true,
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  generate: vi.fn(),
  start: vi.fn(),
  next: vi.fn(),
  refreshQuote: vi.fn(),
  accept: vi.fn()
}));

// Проверяем обработчики самого диалога без DOM и IPC; эффекты и транспорт здесь заменены заглушками.
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const index = fixture.stateIndex++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === 'function' ? initial() : initial;
    return [
      fixture.values[index],
      (next: unknown) => {
        fixture.values[index] = typeof next === 'function' ? next(fixture.values[index]) : next;
      }
    ];
  },
  useRef: (initial: unknown) => {
    const index = fixture.refIndex++;
    return (fixture.refs[index] ??= { current: initial });
  }
}));
vi.mock('../../state', () => ({
  useApp: () => ({
    aiAccess: {
      agent: { provider: null, selected: false, available: false, message: '' },
      image: { provider: 'test-cover-texts', selected: true, available: true, message: '' },
      video: { provider: null, selected: false, available: false, message: '' }
    }
  })
}));
// Этот стенд проверяет согласование уже подготовленного запроса; чтение/сборка контекста покрыты тестами конструктора.
vi.mock('../../hooks/useReferenceImageComposer', () => ({
  useReferenceImageComposer: () => ({ prompt: fixture.session?.prompt ?? '', ready: fixture.contextReady, loading: !fixture.contextReady })
}));
vi.mock('../../hooks/useImageGeneration', () => ({
  useImageGeneration: () => ({
    session: fixture.session,
    preparedSha: fixture.session?.requestSha,
    working: false,
    accepting: false,
    error: null,
    start: fixture.start,
    next: fixture.next,
    refreshQuote: fixture.refreshQuote,
    generate: fixture.generate,
    accept: fixture.accept
  })
}));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function text(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  return isValidElement(value) ? text((value.props as { children?: ReactNode }).children) : '';
}
function draw(props: Partial<Parameters<typeof ImageGenerateDialog>[0]> = {}): Node[] {
  fixture.stateIndex = 0;
  fixture.refIndex = 0;
  return nodes(ImageGenerateDialog({ project: '/test/project', idea: '', onAccepted: vi.fn(), onClose: vi.fn(), ...props }));
}
function button(tree: Node[], title: string): Node {
  const found = tree.find((node) => typeof node.props.onClick === 'function' && text(node.props.children as ReactNode) === title);
  if (!found) throw new Error(`Кнопка не найдена: ${title}`);
  return found;
}
function confirmation(tree: Node[]): Node {
  const found = tree.find((node) => node.type === ConfirmationDialog);
  if (!found) throw new Error('Нет диалога подтверждения');
  return found;
}
function click(node: Node): void {
  (node.props.onClick as () => void)();
}

/** Изменение подписей не должно объединять согласие с ценой и окончательное подтверждение промпта. */
describe('согласование обложки после переноса текстов', () => {
  beforeEach(() => {
    fixture.contextReady = true;
    fixture.values = [];
    fixture.refs = [];
    fixture.stateIndex = 0;
    fixture.refIndex = 0;
    vi.clearAllMocks();
    vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `file://${path}` } } });
    fixture.session = {
      id: 'cover-session',
      prompt: 'Промпт <script> & «обложка»',
      status: 'idle',
      image: null,
      error: null,
      provider: 'test-cover-texts',
      model: 'test-model',
      preparing: false,
      requestSha: 'sha-one',
      approvalToken: 'approval-one',
      quote: { credits: 5, balance: 20, verdict: 'ok' }
    };
  });

  function provider(paid = true): () => void {
    return registerMediaProviderForTests('test-cover-texts', {
      title: 'Провайдер <test> & «имя»',
      kinds: ['image'],
      executor: null,
      paid,
      lipSync: null,
      learnsPriceFromCharges: false,
      generationHistory: null,
      requestParameters: true,
      defaultModelLabel: 'Модель проекта',
      capabilitiesNote: '',
      settingsNotes: {},
      defaults: {},
      modelOrder: {},
      commandLabels: {}
    });
  }

  it('показывает цену, провайдера и промпт перед единственной платной отправкой', () => {
    const restore = provider();
    try {
      let tree = draw();
      expect(confirmation(tree).props.open).toBe(false);
      click(button(tree, 'Сгенерировать обложку · 5 кредитов'));
      expect(fixture.generate).not.toHaveBeenCalled();
      tree = draw();
      const dialog = confirmation(tree);
      expect(dialog.props.open).toBe(true);
      expect(dialog.props.title).toBe('Проверьте промпт перед генерацией');
      expect(dialog.props.description).toBe('Вы уверены, что промпт правильный?');
      expect(dialog.props.confirmLabel).toBe('Сгенерировать обложку');
      expect(dialog.props.cancelLabel).toBe('Отмена');
      const content = nodes(dialog.props.children as ReactNode);
      expect(content.find((node) => node.props.label === 'Подтверждаемый промпт')?.props.value).toBe('Промпт <script> & «обложка»');
      const phrases = content.map((node) => text(node.props.children as ReactNode));
      expect(phrases).toContain('Исполнитель: Провайдер <test> & «имя» · Модель: test-model');
      expect(phrases).toContain('Стоимость: 5 кредитов. Будет отправлен один запрос.');
      const html = renderToStaticMarkup(
        createElement(
          'p',
          null,
          phrases.find((phrase) => phrase === 'Исполнитель: Провайдер <test> & «имя» · Модель: test-model')
        )
      );
      expect(html).toBe('<p>Исполнитель: Провайдер &lt;test&gt; &amp; «имя» · Модель: test-model</p>');
      expect(html).not.toContain('<a ');
      (dialog.props.onConfirm as () => void)();
      (dialog.props.onConfirm as () => void)();
      expect(fixture.generate).toHaveBeenCalledExactlyOnceWith({ approvalToken: 'approval-one', promptConfirmed: true });
      expect(fixture.start).not.toHaveBeenCalled();
      expect(fixture.next).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('требует отдельного согласия на неизвестное списание и теряет его при новой оценке', () => {
    const restore = provider();
    try {
      fixture.session!.quote = { credits: null, balance: 20, verdict: 'cost_or_balance_unknown' };
      let tree = draw();
      expect(button(tree, 'Сгенерировать обложку').props.disabled).toBe(true);
      expect(button(tree, 'Сгенерировать обложку').props.disabledReason).toBe('Сначала нажмите «Я согласен» для показанной оценки стоимости.');
      click(button(tree, 'Я согласен'));
      expect(fixture.generate).not.toHaveBeenCalled();
      tree = draw();
      expect(button(tree, 'Согласие получено').props.disabled).toBe(true);
      expect(button(tree, 'Сгенерировать обложку').props.disabled).toBe(false);
      click(button(tree, 'Сгенерировать обложку'));
      tree = draw();
      const previous = confirmation(tree);
      expect(previous.props.open).toBe(true);
      expect(text(previous.props.children as ReactNode)).toContain('Стоимость: неизвестно. Будет отправлен один запрос.');
      fixture.session = { ...fixture.session!, approvalToken: 'approval-two' };
      tree = draw();
      expect(button(tree, 'Сгенерировать обложку').props.disabled).toBe(true);
      expect(confirmation(tree).props.confirmDisabled).toBe(true);
      (confirmation(tree).props.onConfirm as () => void)();
      expect(fixture.generate).not.toHaveBeenCalled();
      click(button(tree, 'Я согласен'));
      tree = draw();
      click(button(tree, 'Сгенерировать обложку'));
      tree = draw();
      (confirmation(tree).props.onConfirm as () => void)();
      expect(fixture.generate).toHaveBeenCalledExactlyOnceWith({ approvalToken: 'approval-two', promptConfirmed: true, allowUnknownCost: true });
    } finally {
      restore();
    }
  });

  it('не разрешает согласие при недостаточном балансе и сохраняет нейтральную подпись бесплатного исполнителя', () => {
    let restore = provider();
    try {
      fixture.session!.quote = { credits: 5, balance: 1, verdict: 'insufficient_balance' };
      let tree = draw();
      expect(button(tree, 'Сгенерировать обложку').props.disabled).toBe(true);
      expect(button(tree, 'Сгенерировать обложку').props.disabledReason).toBe('Кредитов недостаточно: пополните баланс и обновите стоимость.');
      expect(tree.some((node) => text(node.props.children as ReactNode) === 'Я согласен')).toBe(false);
      restore();
      restore = provider(false);
      tree = draw();
      click(button(tree, 'Сгенерировать обложку'));
      tree = draw();
      expect(text(confirmation(tree).props.children as ReactNode)).toContain('Генерация через Провайдер <test> & «имя» по условиям вашего аккаунта.');
      expect(fixture.generate).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('референс явно показывает назначение, полный прямоугольный оригинал и принимает без обрезки', async () => {
    const restore = provider(false);
    try {
      fixture.session = { ...fixture.session!, status: 'ready', image: { path: '/tmp/wide.png', width: 1536, height: 1024 } };
      const onAccepted = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();
      const tree = draw({ mode: 'reference', target: 'Герой <&>', onAccepted, onClose });
      expect(tree.some((node) => node.type === CoverCropEditor)).toBe(false);
      expect(tree.some((node) => node.props.component === 'img' && node.props.alt === 'Герой <&>')).toBe(true);
      expect(tree.map((node) => text(node.props.children as ReactNode))).toContain('Изображение для: Герой <&>');
      expect(button(tree, 'Принять').props.disabled).toBe(false);
      click(button(tree, 'Принять'));
      const [crop, apply] = fixture.accept.mock.calls[0] as [null, (result: { id: string; path: string; prompt: string }) => Promise<void>];
      expect(crop).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      await apply({ id: 'reference-session', path: '/tmp/wide.png', prompt: 'Герой' });
      expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ id: 'reference-session', path: '/tmp/wide.png', prompt: 'Герой' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('не открывает подтверждение референса до готовности конструктора контекста', () => {
    const restore = provider();
    try {
      fixture.contextReady = false;
      const tree = draw({ mode: 'reference', target: 'Новый герой' });
      expect(button(tree, 'Сгенерировать изображение · 5 кредитов').props.disabled).toBe(true);
      click(button(tree, 'Сгенерировать изображение · 5 кредитов'));
      expect(confirmation(draw({ mode: 'reference', target: 'Новый герой' })).props.open).toBe(false);
      expect(fixture.generate).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('референс сохраняет отдельное подтверждение конкретного платного запроса', () => {
    const restore = provider();
    try {
      let tree = draw({ mode: 'reference', target: 'Новый герой' });
      expect(button(tree, 'Сгенерировать изображение · 5 кредитов').props.disabled).toBe(false);
      expect(tree.map((node) => text(node.props.children as ReactNode))).toContain('SHA запроса: sha-one');
      click(button(tree, 'Сгенерировать изображение · 5 кредитов'));
      expect(fixture.generate).not.toHaveBeenCalled();
      tree = draw({ mode: 'reference', target: 'Новый герой' });
      expect(confirmation(tree).props.open).toBe(true);
      expect(confirmation(tree).props.confirmDisabled).toBe(false);
      expect(confirmation(tree).props.confirmLabel).toBe('Сгенерировать изображение');
      expect(nodes(confirmation(tree).props.children as ReactNode).find((node) => node.props.label === 'Подтверждаемый промпт')?.props.value).toBe(
        fixture.session!.prompt
      );
      (confirmation(tree).props.onConfirm as () => void)();
      (confirmation(tree).props.onConfirm as () => void)();
      expect(fixture.generate).toHaveBeenCalledExactlyOnceWith({ approvalToken: 'approval-one', promptConfirmed: true });
    } finally {
      restore();
    }
  });
});
