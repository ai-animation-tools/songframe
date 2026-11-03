import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { scenarioTexts } from '@shared/texts/scenario';
import { linkSegments } from '../../components/linkTargets';
import { LinkedText } from '../../components/LinkedText';
import { BriefChecklist } from './components/BriefChecklist';
import { BriefComparisonTable } from './components/BriefComparisonTable';
import { BriefSourceLink } from './components/BriefSourceLink';
import { ScenarioComparison } from './components/ScenarioComparison';
import { SceneShotEditor } from './components/SceneShotEditor';
import { ScenesSaveDialog } from './components/ScenesSaveDialog';
import { ScenarioDraftConflictDialog } from './components/ScenarioDraftConflictDialog';
import { ScenarioScenesComparison } from './components/ScenarioScenesComparison';
import { ScenarioCastComparison } from './components/ScenarioCastComparison';
import { ScenarioTreatmentComparison } from './components/ScenarioTreatmentComparison';
import type { SceneShot, ScenesFile } from '@shared/types';

// CSS не относится к видимой фразе; декодирование оставляет пробелы между соседними JSX-узлами для проверки дословности.
function text(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function render(element: ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/project/scenario'] }, element));
}
const noop = (): void => undefined;

const shot: SceneShot = {
  id: 'M01',
  sequence: 'intro',
  start_frame: 0,
  end_frame_exclusive: 30,
  original: '',
  camera: '',
  action: '',
  continuity: '',
  references: [],
  lipsync: false,
  card: { primary_reference: '' },
  state_from: null,
  state_changes: {}
};
const scenes: ScenesFile = {
  schema_version: 1,
  fps: 30,
  audio: { path: '', end_seconds: '' },
  visual_direction: '',
  sequences: [],
  references: {},
  scenes: [shot]
};

describe('Видимые тексты и границы JSX сценария', () => {
  it.each([
    [false, false, 'Изменены: .'],
    [true, false, 'Изменены: трактовка.'],
    [false, true, 'Изменены: реестр сцен.'],
    [true, true, 'Изменены: трактовка, реестр сцен.']
  ])('сохраняет целую JSX-фразу конфликта черновиков %s / %s', (treatmentDirty, scenesDirty, expected) => {
    const dialog = ScenarioDraftConflictDialog({ open: true, treatmentDirty, scenesDirty, busy: false, onResolve: noop, onClose: noop });
    const props = dialog.props as { children: ReactElement; title: string; confirmLabel: string; cancelLabel: string };
    expect(text(render(props.children))).toBe(expected + 'Сначала сохраните правки или явно отмените их. Агент получает только сохранённые данные проекта.');
    expect(props.title).toBe('Есть несохранённые правки');
    expect(props.confirmLabel).toBe('Сохранить и продолжить');
    expect(props.cancelLabel).toBe('Вернуться к редактору');
  });

  it('сравнивает отсутствующие файлы без чтения null before/after', () => {
    expect(text(render(createElement(ScenarioCastComparison, { before: null, after: null })))).toBe(
      'КастингСущностей нет.Словарь свойствбез измененийПолеСейчас в проектеПредложениеСвойства по типам——'
    );
    expect(text(render(createElement(ScenarioTreatmentComparison, { before: null, after: null })))).toBe(
      'ТрактовкаЛоглайнбез измененийПолеСейчас в проектеПредложениеО чём клип——'
    );
    expect(text(render(createElement(ScenarioScenesComparison, { before: null, after: null, selectedIds: [], changedIds: [] })))).toBe(
      'Реестр сценОбщие правила и шкалабез измененийПолеСейчас в проектеПредложениеВизуальные правила——Части——Референсы——Аудио——Частота кадров——'
    );
  });

  it('сохраняет общий пункт, пробелы маркеров фаз и безопасный вывод', () => {
    const html = render(createElement(BriefChecklist, { before: ['Одинаково', '<script>& первый'], after: ['Одинаково', 'Итог "последний"'] }));
    expect(text(html)).toBe('Что сверить в опорах и результатеОдинаково<script>& первый · первый кадрИтог "последний" · последний кадр');
    expect(html).toContain('&lt;script&gt;&amp; первый');
    expect(html).not.toContain('<script>');
    expect(render(createElement(BriefChecklist, { before: [], after: [] }))).toBe('');
  });

  it('сохраняет заголовки кадров и полный счётчик скрытых свойств', () => {
    const html = render(
      createElement(BriefComparisonTable, {
        entities: [
          {
            id: 'hero',
            name: '<Олег & друг>',
            changes: 0,
            rows: [{ key: 'mood', label: 'Настроение', change: 'same', before: { value: 'Спокоен', source: null }, after: { value: 'Спокоен', source: null } }]
          }
        ],
        shot: 'M<&>',
        onlyChanges: true,
        leaveReason: null,
        onOpenShotState: noop
      })
    );
    expect(text(html)).toBe('СвойствоПервый кадр M<&>Последний кадр M<&><Олег & друг>без изменений за план · скрыто без изменений: 1 свойство');
    expect(html).toContain('&lt;Олег &amp; друг&gt;');
  });

  it.each([
    [[], 'без изменений'],
    [[{ label: 'Камера', before: 'А', after: 'Б' }], 'изменено: Камера'],
    [
      [
        { label: 'Камера', before: 'А', after: 'Б' },
        { label: 'Действие', before: 'А', after: 'Б' }
      ],
      'изменено полей: 2'
    ]
  ])('не читает несуществующее изменённое поле и сохраняет подпись %j', (fields, expected) => {
    const html = render(createElement(ScenarioComparison, { title: 'Сравнение', fields }));
    expect(text(html)).toContain('Сравнение' + expected);
    expect(text(html)).toContain('ПолеСейчас в проектеПредложение');
  });

  it.each([
    [{ kind: 'cast' }, 'Кастинг', 'Открыть начальное состояние «Герой <&>» на странице «Кастинг»'],
    [
      { kind: 'plan', shot: 'M01', phase: 'before' },
      'M01 · первый кадр',
      'Прокрутить к блоку «Состояние героев и мира» этого плана: значение задано в «Первый кадр (before)»'
    ],
    [
      { kind: 'plan', shot: 'M02', phase: 'after' },
      'M02 · итог',
      'Открыть план M02 и его блок «Состояние героев и мира»: значение задано в «Итог плана (after)»'
    ]
  ] as const)('сохраняет источник врезки %j', (source, expected, title) => {
    const html = render(
      createElement(BriefSourceLink, { source, entity: 'hero', entityName: 'Герой <&>', currentShot: 'M01', leaveReason: null, onOpenShotState: noop })
    );
    expect(text(html)).toBe(expected);
    expect(html).toContain('title="' + title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"');
    expect(html).not.toContain('<&>');
  });

  it('показывает последний план без обращения к отсутствующему соседу и к derived_from', () => {
    const html = render(
      createElement(SceneShotEditor, {
        shot,
        shotIndex: 1,
        scenes: { ...scenes, scenes: [{ ...shot, id: 'M00' }, shot] },
        referenceOptions: [],
        leaveReason: null,
        updateShot: noop,
        setBoundary: noop,
        split: noop,
        mergeNext: noop
      })
    );
    expect(text(html)).toContain('M010:00.00–0:01.00 · 1.00 с · 30 кадров');
    expect(text(html)).toContain('Разделить план пополам');
    expect(html).toContain('Это последний план: объединять не с чем.');
  });

  it('сохраняет нулевой счётчик закрытого диалога и не читает null request', () => {
    const dialog = ScenesSaveDialog({ request: null, busy: false, onConfirm: noop, onClose: noop });
    const content = dialog.props as { children: ReactElement[]; description: string };
    expect(text(renderToStaticMarkup(createElement('div', null, content.children)))).toBe('Затронутые планы: 0');
    expect(content.description).toBe(
      'Сохранение меняет постановку планов ниже. Принятые из них получат статус «постановка изменена» и потребуют нового производства, а их пакеты — нового согласования. Если правка не меняет сюжет, например исправляет опечатку, выберите «Сохранить без производства». Аниматик после сохранения потребует пересборки — это локальная операция без оплаты.'
    );
  });
});

describe('Текст сценария сохраняет маршруты ссылок', () => {
  it.each([
    [scenarioTexts.prerequisites.timing, 'На странице «Тайминги» разметьте строки песни и сохраните результат.', '/project/timing'],
    [scenarioTexts.prerequisites.duration, 'На странице «Тайминги» заново разметьте трек, чтобы определить его длительность.', '/project/timing'],
    [scenarioTexts.prerequisites.cast, 'На странице «Кастинг» создайте героев и другие объекты клипа.', '/project/cast'],
    [scenarioTexts.prerequisites.reference, 'На странице «Кастинг» добавьте изображение хотя бы одному герою или объекту.', '/project/cast']
  ])('сохраняет всю фразу и цель %s', (actual, expected, route) => {
    const segments = linkSegments(actual, '/project/scenario');
    expect(segments.map((segment) => segment.text).join('')).toBe(expected);
    expect(segments.filter((segment) => segment.target).map((segment) => segment.target?.path)).toEqual([route]);
    const html = render(createElement(LinkedText, { text: actual }));
    expect(text(html)).toBe(expected);
    expect(html).toContain('href="' + route + '"');
  });
});
