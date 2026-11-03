/** Проверяем подтверждение разблокировки и начальное readOnly без настоящего агента. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTheme, ThemeProvider } from '@mui/material';
import { describe, expect, it, vi } from 'vitest';
import { projectTexts } from '@shared/texts/project';
import { ProjectAgentInstructions } from './ProjectAgentInstructions';
import { instructionEditor } from './instructionEditor';

describe('блокировка постоянных инструкций', () => {
  it('отмена не разблокирует поле, а подтверждение без открытого диалога ничего не меняет', () => {
    expect(instructionEditor('locked', 'confirm')).toBe('locked');
    expect(instructionEditor(instructionEditor('locked', 'request'), 'cancel')).toBe('locked');
    expect(instructionEditor(instructionEditor('locked', 'request'), 'confirm')).toBe('editing');
    expect(instructionEditor('editing', 'lock')).toBe('locked');
  });

  it('показывает точное предупреждение пользователя', () => {
    expect(projectTexts.agentInstructions.warning).toBe('Изменяйте содержимое этого поля только если точно понимаете что делаете.');
  });

  it.each(['light', 'dark'] as const)('%s: поле изначально readOnly, выбранный агент разрешает только запрос разблокировки', (mode) => {
    const render = (agentProvider: 'codex' | null): string =>
      renderToStaticMarkup(
        createElement(
          ThemeProvider,
          { theme: createTheme({ palette: { mode } }) },
          createElement(ProjectAgentInstructions, { value: '  Инструкция <&>\nСтрока 2  ', agentProvider, busy: false, onChange: vi.fn() })
        )
      ).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
    const selected = render('codex');
    expect(selected).toMatch(/<textarea[^>]*readOnly=""/);
    expect(selected).toContain('  Инструкция &lt;&amp;&gt;\nСтрока 2  ');
    expect(selected).toContain('Поле заблокировано.');
    expect(selected).toMatch(/<button(?![^>]*disabled)[^>]*>[\s\S]*?Разблокировать<\/button>/);
    const absent = render(null);
    expect(absent).toMatch(/<textarea[^>]*readOnly=""/);
    expect(absent).toContain('Для редактирования выберите текстового агента');
    expect(absent).toMatch(/<button[^>]*disabled=""/);
  });
});
