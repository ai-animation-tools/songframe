import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentInstructionsTexts } from '@shared/texts/agent-instructions';
import { SlottedText } from './SlottedText';

// Ожидания записаны независимо от шаблона: проверяются текст, место команды и безопасная React-разметка.
describe('Инструкции с именованными элементами', () => {
  it.each([
    ['терминале', 'Выполните вход в терминале: <code>test login</code>.'],
    ['PowerShell или CMD', 'Выполните вход в PowerShell или CMD: <code>test login</code>.']
  ])('сохраняет команду входа в %s', (terminal, expected) => {
    expect(
      renderToStaticMarkup(
        createElement(SlottedText, {
          text: agentInstructionsTexts.login({ terminal }),
          slots: { command: createElement('code', null, 'test login') }
        })
      )
    ).toBe(expected);
  });

  it('сохраняет текст ручной проверки', () => {
    expect(
      renderToStaticMarkup(
        createElement(SlottedText, {
          text: agentInstructionsTexts.status,
          slots: { command: createElement('code', null, 'test status') }
        })
      )
    ).toBe('Проверка вручную: <code>test status</code>.');
  });

  it('сохраняет порядок, повторения, неизвестные слоты и ссылки', () => {
    expect(
      renderToStaticMarkup(
        createElement(SlottedText, {
          text: '{second} / {first} / {second} / {missing}',
          slots: { first: createElement('a', { href: '/settings' }, 'Настройки'), second: createElement('code', null, 'x') }
        })
      )
    ).toBe('<code>x</code> / <a href="/settings">Настройки</a> / <code>x</code> / {missing}');
  });

  it('сохраняет явно пустой слот и не интерпретирует HTML или вложенную подстановку', () => {
    expect(
      renderToStaticMarkup(
        createElement(SlottedText, {
          text: 'Начало{empty}: {command} <script> / {toString}',
          slots: { empty: null, command: '<img src="x"> {empty}' }
        })
      )
    ).toBe('Начало: &lt;img src=&quot;x&quot;&gt; {empty} &lt;script&gt; / {toString}');
  });
});
