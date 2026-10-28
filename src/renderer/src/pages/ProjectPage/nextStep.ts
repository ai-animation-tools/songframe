/** Подсказка следующего действия по текущему состоянию проекта. */

import type { ProjectState, ProjectStatus } from '@shared/types';

interface NextStep {
  title: string;
  text: string;
  action?: { label: string; to: string };
}

export function nextStep(status: ProjectStatus): NextStep {
  const steps: Record<ProjectState, NextStep> = {
    invalid: { title: 'Папка не является проектом', text: 'Нет plan/project.json. Создайте проект заново или выберите другую папку.' },
    empty: {
      title: 'Добавить исходники',
      text: 'Трек, текст песни, идея клипа, по желанию обложка и референсы.',
      action: { label: 'К исходникам', to: '/project/sources' }
    },
    sourced: {
      title: 'Разметить трек',
      text: 'Черновик делает кнопка «Разметить» на странице таймингов; затем границы строк подтверждаются на слух.',
      action: { label: 'К таймингам', to: '/project/timing' }
    },
    timed: status.checks.cast
      ? status.checks.treatment
        ? {
            title: 'Собрать реестр сцен',
            text: 'Трактовка есть. Постройте каркас сцен и заполните постановку в редакторе или поручите её агенту на странице сценария.',
            action: { label: 'К сценарию', to: '/project/scenario' }
          }
        : {
            title: 'Написать трактовку',
            text: 'Кастинг есть. Разделите песню на части с действием и участниками в редакторе или поручите трактовку агенту на странице сценария.',
            action: { label: 'К сценарию', to: '/project/scenario' }
          }
      : {
          title: 'Собрать кастинг',
          text: 'Сущности клипа из референсов, роль, внешность и начальное состояние мира и героев. Это основа непрерывности между сценами.',
          action: { label: 'К кастингу', to: '/project/cast' }
        },
    scripted: {
      title: 'Начать производство сцен',
      text: 'Описание, опоры, промпт и запрос каждого плана готовит агент по кнопкам страницы «Производство»; там же вы подтверждаете их, стоимость и результат. Готовность сцены определяется комплектом в assets/shots.',
      action: { label: 'К производству', to: '/project/production' }
    },
    in_production: {
      title: `Сцены: ${status.checks.shotsDone} из ${status.checks.shotsTotal}`,
      text: status.problems.length ? status.problems.join(' ') : 'Продолжайте принимать сцены; после последней соберите и примите аниматик.',
      action:
        status.checks.shotsDone < status.checks.shotsTotal
          ? { label: 'К производству', to: '/project/production' }
          : { label: 'К аниматику', to: '/project/animatic' }
    },
    complete: {
      title: 'Клип завершён',
      text: 'Все сцены приняты, аниматик собран по актуальному реестру и принят. Пакет для монтажёра собирается ниже на этой странице.',
      action: { label: 'К аниматику', to: '/project/animatic' }
    }
  };
  return steps[status.state];
}
