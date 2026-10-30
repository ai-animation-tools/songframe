/** Причина недоступности действий ИИ с переходом туда, где её можно устранить. */
import { componentsTexts } from '@shared/texts/components';
import type { ReactElement } from 'react';
import { Alert, Button } from '@mui/material';
import { SettingsOutlined, TuneOutlined } from '@mui/icons-material';
import { aiActionProblem, type AiActionKind } from '@shared/ai-access';
import { useApp } from '../state';

/** Агент выбирается в настройках приложения, провайдеры медиа — в настройках проекта; ссылки HashRouter работают и вне контекста маршрутизатора. */
export function AiProblemAlert({ kinds = ['agent'] }: { kinds?: AiActionKind[] }): ReactElement | null {
  const { aiAccess, online } = useApp();
  // Без сети причину уже объясняет общее сообщение под шапкой.
  if (!online) return null;
  const problems = kinds.map((kind) => ({ kind, message: aiActionProblem(aiAccess, kind) })).filter((item) => item.message);
  if (!problems.length) return null;
  const agent = problems.some((item) => item.kind === 'agent');
  const media = problems.some((item) => item.kind !== 'agent');
  return (
    <Alert
      severity="info"
      action={
        aiAccess ? (
          <>
            {agent ? (
              <Button color="inherit" size="small" startIcon={<SettingsOutlined />} href="#/settings">
                {componentsTexts.aiProblem.openSettings}
              </Button>
            ) : null}
            {media ? (
              <Button color="inherit" size="small" startIcon={<TuneOutlined />} href="#/project">
                {componentsTexts.aiProblem.projectSettings}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {[...new Set(problems.map((item) => item.message))].join(' ')}
    </Alert>
  );
}
