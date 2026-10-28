/** Возврат сохраняет замечание и объясняет запуск доработки в приложении. */
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '@mui/material';
import { describe, expect, it, vi } from 'vitest';
import type { PackageView } from '@shared/types';
import { PackageRevisionNotice } from './PackageRevisionNotice';
import { PackageCard } from './PackageCard';

vi.mock('../../../state', () => ({ useApp: () => ({ agentProvider: null, aiAccess: null }) }));

const note = 'Изменить движение героя.\nСохранить одежду и направление камеры.';
const fixture = (overrides: Partial<PackageView> = {}): PackageView => ({
  dir: '/fixture/package',
  relative: 'package',
  shot: 'M44',
  stage: 'prompt_review',
  stageLabel: 'Промпт возвращён',
  waitReason: null,
  mode: null,
  retryOf: null,
  batch: null,
  timing: null,
  keyframes: [],
  description: null,
  prompt: null,
  request: null,
  pendingDecision: null,
  decision: { stage: 'prompt_review', verdict: 'revise', note },
  preview: [],
  problems: [],
  ...overrides
});

const render = (pkg = fixture(), onOpenRevision?: () => void): string => renderToStaticMarkup(createElement(PackageRevisionNotice, { pkg, onOpenRevision }));

describe('Продолжение после возврата пакета', () => {
  it('показывает сохранённый текст и объясняет ручной запуск доработки приложения', () => {
    const html = render(fixture(), vi.fn());
    expect(html).toContain('Пакет возвращён с замечанием');
    expect(html).toContain(note);
    expect(html).toContain('Возврат с замечанием не запускает агента автоматически.');
    expect(html).toContain('Запуск и результат доработки — в блоке «Подготовка плана».');
    expect(html).toContain('«Запустить доработку с агентом», если ещё не запускали её.');
    expect(html).not.toContain('Доработка не запущена');
    expect(html).toContain('white-space:pre-wrap');
    expect(html).toContain('overflow-wrap:anywhere');
  });

  it('показывает обычную навигацию и передаёт нажатие в переход к подготовке', () => {
    const onOpenRevision = vi.fn();
    const element = PackageRevisionNotice({ pkg: fixture(), onOpenRevision });
    expect(isValidElement<{ children: ReactNode }>(element)).toBe(true);
    if (!isValidElement<{ children: ReactNode }>(element)) throw new Error('Пояснение возврата должно быть видимо');
    const actionBox = Children.toArray(element.props.children).find(
      (child) => isValidElement<{ children?: unknown }>(child) && isValidElement(child.props.children) && child.props.children.type === Button
    );
    expect(isValidElement<{ children: { props: { onClick(): void; children: string } } }>(actionBox)).toBe(true);
    if (isValidElement<{ children: { props: { onClick(): void; children: string } } }>(actionBox)) {
      expect(actionBox.props.children.props.children).toBe('Перейти к доработке');
      actionBox.props.children.props.onClick();
    }
    expect(onOpenRevision).toHaveBeenCalledOnce();
    const html = render(fixture(), onOpenRevision);
    expect(html).toContain('data-testid="ArrowForwardIcon"');
    expect(html).not.toContain('Claude');
    expect(html).not.toContain('Codex');
    expect(html).not.toContain('disabled=""');
  });

  it('сохраняет пояснение без необязательного перехода', () => {
    const html = render();
    expect(html).toContain('«Запустить доработку с агентом»');
    expect(html).not.toContain('<button');
  });

  it.each([
    { decision: null },
    { decision: { stage: 'prompt_review', verdict: 'approve' } },
    { pendingDecision: { stage: 'prompt_review', question: 'Проверить новый промпт?', options: ['approve', 'revise'] } }
  ])('не смешивает старое замечание с другим решением или новым вопросом: %j', (overrides) => {
    expect(render(fixture(overrides))).toBe('');
  });

  it('в карточке показывает сохранённый возврат без дублирования последнего ответа', () => {
    const html = renderToStaticMarkup(
      createElement(PackageCard, {
        pkg: fixture(),
        note: '',
        setNote: vi.fn(),
        busy: false,
        providers: {},
        onDecide: vi.fn(),
        onSubmit: vi.fn(),
        onAccept: vi.fn(),
        onContactSheet: vi.fn(),
        onResume: vi.fn(),
        onAttachResult: vi.fn(),
        onNotCreated: vi.fn(),
        onSelectImage: vi.fn(),
        onOpenRevision: vi.fn()
      })
    );
    expect(html).toContain(note);
    expect(html).not.toContain('последний ответ:');
    expect(html).toContain('Перейти к доработке');
  });
});
