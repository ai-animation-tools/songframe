/** Проверяет готовые сообщения main и отображение передаваемых через IPC сведений о проверках. */
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { JobInfo, ProjectSettings } from '@shared/types';
import { CHECKS, Checks, validateProjectSettings } from './checks';
import type { Jobs } from './jobs';

function jobsStub(): Jobs {
  return {
    start: vi.fn<Jobs['start']>((kind, title, project, steps) => ({
      id: 'checks-test',
      kind,
      title,
      project,
      status: 'running',
      startedAt: '2026-10-29T00:00:00Z',
      finishedAt: null,
      log: '',
      code: null,
      steps: steps.map((step) => ({ label: step.label ?? step.tool, tool: step.tool, status: 'pending', code: null }))
    }))
  } as unknown as Jobs;
}

describe('тексты проверок main → renderer', () => {
  it('показывает названия и описания main после передачи простых данных', async () => {
    // Загружаем renderer через Vitest: node tsconfig не компилирует JSX компонентов интерфейса.
    const { ProjectChecksPanel } = await vi.importActual<{ ProjectChecksPanel: ComponentType<Record<string, unknown>> }>(
      '../renderer/src/pages/ChecksPage/components/ProjectChecksPanel'
    );
    const html = renderToStaticMarkup(
      createElement(ProjectChecksPanel, {
        checks: JSON.parse(JSON.stringify(CHECKS)),
        disabled: false,
        disabledReason: null,
        strict: false,
        next: false,
        setStrict: vi.fn(),
        setNext: vi.fn(),
        runAll: vi.fn(),
        outcome: () => null,
        updateViews: vi.fn(),
        runCheck: vi.fn()
      })
    ).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
    for (const text of ['Данные сцен', 'Карточки и списки', 'Комплекты сцен', 'Порядок в папке проекта', 'Статусы планов']) {
      expect(html).toContain(text);
    }
    expect(html).toContain(
      'Проверить формат реестра сцен, комплектов и рабочих пакетов. Постановка, исходники и результаты должны храниться в отведённых им файлах.'
    );
    expect(html).toContain('Проверить, что монтажный список, раскадровка, карточки и список принятых материалов соответствуют реестру сцен.');
    expect(html).toContain('Проверить сохранность файлов принятых сцен и совпадение длительности монтажа с данными о приёмке.');
    expect(html).toContain('Найти лишние рабочие пакеты, карточки и пустые папки, оставшиеся после приёмки сцен.');
    expect(html).toContain('Показать готовые планы, текущие попытки и очередь согласования. Помогает выбрать следующий план для работы.');
    expect(html).toContain('Проверки проекта');
    expect(html).toContain('Запустить все');
    expect(html).toContain('Пересобрать карточки');
    expect(html).toContain('Предупреждения считать ошибками');
    expect(html).toContain('Следующий план и очередь');
  });

  it.each([
    [false, 'Проба M05 M05.1', 'Сборка пробы стыков'],
    [true, 'Проба M05 M05.1 (проверка без видео)', 'Проверка пробы без видео']
  ] as const)('сохраняет заголовок, режим и шаг пробы planOnly=%s', (planOnly, title, label) => {
    const jobs = jobsStub();
    const result: JobInfo = new Checks(jobs).buildReview('/project', { shots: [' M05 ', 'M05.1'], planOnly });
    expect(result.title).toBe(title);
    expect(result.steps[0].label).toBe(label);
    const args = vi.mocked(jobs.start).mock.calls[0][3][0].args;
    expect(args.slice(0, 3)).toEqual(['--shots', 'M05', 'M05.1']);
    expect(args.includes('--plan-only')).toBe(planOnly);
  });

  it('сохраняет ошибки выбора пробы и общий запуск', () => {
    const checks = new Checks(jobsStub());
    expect(() => checks.buildReview('/project', { shots: [], planOnly: false })).toThrow('Выберите хотя бы один план для пробы.');
    expect(() => checks.buildReview('/project', { shots: ['bad', '../M05'], planOnly: false })).toThrow('Коды планов вида M05 или M05.1: bad, ../M05');
    expect(checks.run('/project', 'lint').title).toBe('Проверка: Данные сцен');
    expect(checks.runAll('/project').title).toBe('Все проверки');
    expect(checks.updateViews('/project').title).toBe('Обновление карточек и списков');
  });

  it('сохраняет сообщения и порядок ошибок повреждённых настроек', () => {
    const settings = {
      name: '',
      animaticVideo: '../clip.mp4',
      generation: { video: false, image: { provider: '', model: '', aspect_ratio: 'bad', watermark: 1, provider_selected: 'yes', options: [], outputs: 0 } }
    } as unknown as ProjectSettings;
    expect(validateProjectSettings(settings)).toEqual([
      'Название проекта не может быть пустым.',
      'Имя MP4 аниматика: буквы, цифры, точки и дефисы, без пути к папке, с расширением .mp4.',
      'generation.video: ожидается объект настроек.',
      'generation.image: не заполнено поле provider.',
      'generation.image: model должен быть непустой строкой.',
      'generation.image: пропорции записываются как 16:9 или auto.',
      'generation.image: watermark должен быть логическим значением.',
      'generation.image: provider_selected должен быть логическим значением.',
      'generation.image: options должен быть объектом.',
      'generation.image: outputs должен быть положительным целым числом.'
    ]);
  });
});
