/** Ожидания независимы от словаря: проверяем целые сообщения, протокол ошибок и сохранность вставок. */
import { describe, expect, it } from 'vitest';
import { agentsTexts } from '@shared/texts/agents';
import { AgentError, JsonLines, providerDetail, providerFailure, redact } from './agent-protocol';
import { createAgentAdapter } from './agent-adapters';
import { AGENT_CLI_PROBES } from './agent-probes';

const provider = '/папка с пробелами/"CLI"; $(touch файл) & <агент>';

describe('общие сообщения агента', () => {
  it('сохраняет целые фразы, пути и спецсимволы названия без обработки', () => {
    expect(agentsTexts.notFound({ provider })).toBe(
      '/папка с пробелами/"CLI"; $(touch файл) & <агент> не найден в PATH, ~/.local/bin, /usr/local/bin и /usr/bin. Установите его по официальной инструкции и повторите проверку.'
    );
    expect(agentsTexts.versionCheckFailed({ provider })).toBe(
      'Команда версии завершилась с ошибкой. Проверьте /папка с пробелами/"CLI"; $(touch файл) & <агент> и его зависимости в терминале.'
    );
    expect(agentsTexts.checkVersionUnknown({ provider })).toBe(
      '/папка с пробелами/"CLI"; $(touch файл) & <агент> запускается, но его версия не распознана. Обновите его до поддерживаемой версии.'
    );
    expect(agentsTexts.versionUnknown({ provider })).toBe(
      'Версия /папка с пробелами/"CLI"; $(touch файл) & <агент> не распознана. Обновите его до поддерживаемой версии.'
    );
    expect(agentsTexts.launchFailed({ provider })).toBe(
      'Не удалось запустить /папка с пробелами/"CLI"; $(touch файл) & <агент>. Проверьте его установку и зависимости.'
    );
    expect(agentsTexts.login({ command: '"/моя папка/cli" login --name="А & Б"' })).toBe('Выполните "/моя папка/cli" login --name="А & Б" в терминале.');
  });

  it.each([
    ['not logged in', 'AUTH_REQUIRED', 'Агент сообщил об ошибке входа. Проверьте авторизацию в настройках.'],
    ['quota exceeded', 'RATE_LIMIT', 'Агент сообщил об ограничении использования. Проверьте лимиты аккаунта.'],
    ['model unavailable', 'CLI_ERROR', 'Агент сообщил об ошибке задания. Проверьте его настройки и доступность выбранной модели.']
  ])('сохраняет Error.message и detail для %s без добавления сырого stderr', (stderr, code, detail) => {
    const error = providerFailure(`${stderr}\nSECRET /сырой stderr`);
    expect(error).toBeInstanceOf(AgentError);
    expect(error.code).toBe(code);
    expect(error.detail).toBe(detail);
    expect(error.message).toBe(`[${code}] ${detail}`);
    expect(JSON.stringify(error)).not.toContain('SECRET');
  });

  it('обрамляет очищенную причину целой фразой, сохраняет кавычки и убирает переносы', () => {
    const error = providerFailure('401', '  Путь «/мой клип/a & b.json»\naccess_token=SECRET\r\n<ошибка>  ');
    expect(error.detail).toBe(
      'Агент сообщил об ошибке входа. Проверьте авторизацию в настройках. Сообщение агента: «Путь «/мой клип/a & b.json» access_token=[скрыто] <ошибка>»'
    );
    expect(error.message).toBe(
      '[AUTH_REQUIRED] Агент сообщил об ошибке входа. Проверьте авторизацию в настройках. Сообщение агента: «Путь «/мой клип/a & b.json» access_token=[скрыто] <ошибка>»'
    );
    expect(providerFailure('429', 'Лимит «5 & 6»').detail).toBe(
      'Агент сообщил об ограничении использования. Проверьте лимиты аккаунта. Сообщение агента: «Лимит «5 & 6»»'
    );
    expect(providerFailure('unknown', '/путь "клип"; $(x)').detail).toBe(
      'Агент сообщил об ошибке задания. Проверьте его настройки и доступность выбранной модели. Сообщение агента: «/путь "клип"; $(x)»'
    );
  });

  it('оставляет прежние маркеры редактирования и границу длины причины', () => {
    expect(redact('sk-abcdefgh Bearer abcd.ef api_key="секрет"; refresh_token=SECRET')).toBe('[скрыто] [скрыто] api_key="[скрыто]"; refresh_token=[скрыто]');
    expect(providerDetail('я'.repeat(401))).toBe('я'.repeat(400) + '…');
    expect(providerFailure('auth', '\n\t').detail).toBe('Агент сообщил об ошибке входа. Проверьте авторизацию в настройках.');
  });

  it.each([
    ['не JSON\n', '[PROTOCOL_ERROR] Агент вернул некорректный JSONL.'],
    ['[]\n', '[PROTOCOL_ERROR] Ожидался объект события агента.']
  ])('сохраняет полный Error.message JSONL для %s', (input, expected) => {
    expect(() => new JsonLines(() => {}).push(Buffer.from(input))).toThrow(expected);
  });

  it('сохраняет сообщение ограничения строки и ошибку конкретного протокола Codex', () => {
    expect(() => new JsonLines(() => {}, 2).push(Buffer.from('яя'))).toThrow('[OUTPUT_LIMIT] Строка ответа агента слишком велика.');
    const adapter = createAgentAdapter('codex');
    adapter.parse({ type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Прежний текст' } });
    expect(() => adapter.parse({ type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Новый текст' } })).toThrow(
      '[PROTOCOL_ERROR] Codex изменил уже полученный текст сообщения.'
    );
  });

  it('сохраняет различие подтверждений входа и команды конкретных CLI', () => {
    expect(AGENT_CLI_PROBES.claude.authorization({ code: 0, stdout: '{"loggedIn":true}', output: '' })).toEqual({
      authorization: 'authenticated',
      message: 'Claude Code сообщает, что вход выполнен.'
    });
    expect(AGENT_CLI_PROBES.codex.authorization({ code: 0, stdout: '', output: '\nLogged in using ChatGPT\n' })).toEqual({
      authorization: 'authenticated',
      message: 'Codex сообщает, что учётные данные для входа найдены.'
    });
    expect(AGENT_CLI_PROBES.claude.authorization({ code: 1, stdout: '{"loggedIn":false}', output: '' })).toEqual({
      authorization: 'unauthenticated',
      message: 'Выполните claude auth login в терминале.'
    });
    expect(AGENT_CLI_PROBES.codex.authorization({ code: 1, stdout: '', output: 'Not logged in\n' })).toEqual({
      authorization: 'unauthenticated',
      message: 'Выполните codex login в терминале.'
    });
  });
});
