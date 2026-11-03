import { projectTexts } from '@shared/texts/project';
/** Подсказка следующего действия по текущему состоянию проекта. */

import type { ProjectState, ProjectStatus } from '@shared/types';

interface NextStep {
  title: string;
  text: string;
  action?: { label: string; to: string };
}

export function nextStep(status: ProjectStatus): NextStep {
  const steps: Record<ProjectState, NextStep> = {
    invalid: { title: projectTexts.nextStep.invalidTitle, text: projectTexts.nextStep.invalidText },
    empty: {
      title: projectTexts.nextStep.sourcesTitle,
      text: projectTexts.nextStep.sourcesText,
      action: { label: projectTexts.nextStep.toSources, to: '/project/sources' }
    },
    sourced: {
      title: projectTexts.nextStep.timingTitle,
      text: projectTexts.nextStep.timingText,
      action: { label: projectTexts.nextStep.toTiming, to: '/project/timing' }
    },
    timed: status.checks.cast
      ? status.checks.treatment
        ? {
            title: projectTexts.nextStep.scenesTitle,
            text: projectTexts.nextStep.scenesText,
            action: { label: projectTexts.nextStep.toScenario, to: '/project/scenario' }
          }
        : {
            title: projectTexts.nextStep.treatmentTitle,
            text: projectTexts.nextStep.treatmentText,
            action: { label: projectTexts.nextStep.toScenario, to: '/project/scenario' }
          }
      : {
          title: projectTexts.nextStep.castTitle,
          text: projectTexts.nextStep.castText,
          action: { label: projectTexts.nextStep.toCast, to: '/project/cast' }
        },
    scripted: {
      title: projectTexts.nextStep.productionTitle,
      text: projectTexts.nextStep.productionText,
      action: { label: projectTexts.nextStep.toProduction, to: '/project/production' }
    },
    in_production: {
      title: projectTexts.nextStep.scenes({ done: status.checks.shotsDone, total: status.checks.shotsTotal }),
      text: status.problems.length ? status.problems.join(' ') : projectTexts.nextStep.continueProduction,
      action:
        status.checks.shotsDone < status.checks.shotsTotal
          ? { label: projectTexts.nextStep.toProduction, to: '/project/production' }
          : { label: projectTexts.nextStep.toAnimatic, to: '/project/animatic' }
    },
    complete: {
      title: projectTexts.nextStep.completeTitle,
      text: projectTexts.nextStep.completeText,
      action: { label: projectTexts.nextStep.toAnimatic, to: '/project/animatic' }
    }
  };
  return steps[status.state];
}
