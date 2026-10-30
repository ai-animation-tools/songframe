/** Полные сообщения IPC сохраняют параметры и переходы при показе в renderer. */
import { describe, expect, it } from 'vitest';
import { applicationTexts } from '@shared/texts/application';

// Ожидания независимы от словарей и таблиц маршрутов; имена тестовых сервисов не ограничивают реестр приложения.
describe('сообщения обвязки IPC', () => {
  it('сохраняет восстановление проекта и системную диагностику с точными переносами строк', () => {
    expect(applicationTexts.projectRecoveryTitle).toBe('Не удалось восстановить файлы проекта');
    expect(applicationTexts.projectRecoveryFailed({ reason: 'Ошибка «Файл» & <copy>\nC:\\Клип\\резерв' })).toBe(
      'Ошибка «Файл» & <copy>\nC:\\Клип\\резерв\n\nРезервные копии сохранены. Текущий проект закрыт: устраните причину перед дальнейшей работой с ним. Можно открыть другой проект.'
    );
    expect(applicationTexts.startupFailedTitle).toBe('SongFrame: ошибка запуска');
    expect(applicationTexts.desktop.commandMissing({ command: 'C:\\Папка «А»\\open.exe' })).toBe('Не найдена системная команда C:\\Папка «А»\\open.exe.');
    expect(applicationTexts.desktop.commandTimedOut).toBe('Системная команда открытия не ответила вовремя.');
    expect(applicationTexts.desktop.commandFailed).toBe('Системная команда открытия завершилась с ошибкой.');
  });

  it('сохраняет выбор платного исполнителя для пустого, одного и нескольких названий', () => {
    expect(applicationTexts.choosePaidImageProvider({ titles: [] })).toBe('Выберите платного провайдера для изображений в настройках проекта.');
    expect(applicationTexts.choosePaidImageProvider({ titles: ['Тест «А»'] })).toBe('Выберите Тест «А» для изображений в настройках проекта.');
    expect(applicationTexts.choosePaidImageProvider({ titles: ['Тест <А>', 'Тест & Б'] })).toBe(
      'Выберите Тест <А> или Тест & Б для изображений в настройках проекта.'
    );
  });

  it('сохраняет пути, кавычки, строки и буквальные имена слотов без повторного разбора', () => {
    expect(applicationTexts.sourcesInvalid({ path: 'C:\\Клип «А»\\{path}' })).toBe('В папке нет tools/common.py: C:\\Клип «А»\\{path}');
    expect(applicationTexts.scaffoldFailed({ details: 'ошибка <А>\n{details} & "Б"' })).toBe('Не удалось подготовить каркас: ошибка <А>\n{details} & "Б"');
    expect(applicationTexts.scenarioReviewFailed({ reason: '' })).toBe('Не удалось проверить актуальность сценария: ');
    expect(applicationTexts.chooseVideoProvider({ titles: '' })).toBe('Выберите поддерживаемого провайдера видео: .');
  });

  it('сохраняет порядок и пробелы нескольких ошибок текста песни', () => {
    expect(applicationTexts.lyricsInvalid({ problems: [] })).toBe('Исправьте текст песни на странице «Исходники»: ');
    expect(applicationTexts.lyricsInvalid({ problems: ['Ошибка 1.', '', 'Ошибка «2».'] })).toBe(
      'Исправьте текст песни на странице «Исходники»: Ошибка 1.  Ошибка «2».'
    );
  });

  it.each([
    [0, 1, 'Провайдер видео принимает звук длиной от 0 до 1 с: поправьте границы среза.'],
    [1, 2, 'Провайдер видео принимает звук длиной от 1 до 2 с: поправьте границы среза.'],
    [2, 3, 'Провайдер видео принимает звук длиной от 2 до 3 с: поправьте границы среза.'],
    [5, 6, 'Провайдер видео принимает звук длиной от 5 до 6 с: поправьте границы среза.'],
    [11, 12, 'Провайдер видео принимает звук длиной от 11 до 12 с: поправьте границы среза.'],
    [21, 22, 'Провайдер видео принимает звук длиной от 21 до 22 с: поправьте границы среза.'],
    [-2, -1, 'Провайдер видео принимает звук длиной от -2 до -1 с: поправьте границы среза.'],
    [1.5, 2.5, 'Провайдер видео принимает звук длиной от 1.5 до 2.5 с: поправьте границы среза.']
  ])('сохраняет числовую запись границ %s–%s', (min, max, expected) => {
    expect(applicationTexts.speechDuration({ min, max })).toBe(expected);
  });
});
