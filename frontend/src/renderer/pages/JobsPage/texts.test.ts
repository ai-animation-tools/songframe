/** Системные данные отчёта и журнала передаются дословно; UI добавляет только прежнюю обвязку. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { jobsTexts } from '@shared/texts/jobs';
import type { JobInfo } from '@shared/types';
import { ToolJobEntry } from './components/ToolJobEntry';

describe('Тексты журнала заданий', () => {
  const special = '<&>"/C:\\клип {job}';

  it('сохраняет целые сообщения копирования, отчёта, фильтра и ошибки', () => {
    expect(jobsTexts.copied({ title: special })).toBe('Журнал задания «<&>"/C:\\клип {job}» скопирован');
    expect(jobsTexts.reportSaved({ path: special })).toBe('Отчёт сохранён: <&>"/C:\\клип {job}. Отправьте этот файл разработчику.');
    expect(jobsTexts.currentProject({ name: special })).toBe('Текущий: <&>"/C:\\клип {job}');
    expect(jobsTexts.refreshFailed({ reason: special })).toBe('Не удалось обновить журнал: <&>"/C:\\клип {job}');
    expect(jobsTexts.refreshFailed({ reason: '' })).toBe('Не удалось обновить журнал: ');
  });

  it('сохраняет полный текст пояснения, включая пробелы между прежними JSX-строками', () => {
    expect(jobsTexts.description).toBe(
      'Инструменты и агенты в порядке запуска, новые сверху. Общие задания приложения видны вместе с заданиями выбранного проекта. Статусы обновляются автоматически. Журнал сохраняется между запусками: задания прошлых сеансов отмечены отдельно. Если программа завершилась сбоем, сохраните отчёт для разработчика и отправьте ему файл.'
    );
  });

  it('экранирует живой вывод задания и сохраняет подпись копирования', () => {
    const job: JobInfo = {
      id: 'test',
      kind: 'submit',
      title: 'Шаг <&>',
      status: 'done',
      startedAt: '2026-10-29T12:00:00Z',
      finishedAt: '2026-10-29T12:00:01Z',
      code: 0,
      steps: [],
      log: 'stdout: <script>данные</script>\nstderr: & ошибка'
    };
    const html = renderToStaticMarkup(createElement(ToolJobEntry, { job, onCopy: () => undefined }));
    expect(html).toContain('Скопировать журнал');
    expect(html).toContain('stdout: &lt;script&gt;данные&lt;/script&gt;\nstderr: &amp; ошибка');
    expect(html).not.toContain('<script>');
  });
});
