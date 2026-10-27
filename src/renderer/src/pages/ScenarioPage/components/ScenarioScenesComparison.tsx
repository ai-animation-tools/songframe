import type { ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { SceneShot, ScenesFile } from '@shared/types';
import { ScenarioComparison } from './ScenarioComparison';

/** Поля состояния показываются вместе с постановкой: их наследуют последующие планы. */
export function ScenarioScenesComparison({
  before,
  after,
  selectedIds,
  changedIds
}: {
  before: ScenesFile | null;
  after: ScenesFile | null;
  selectedIds: string[];
  changedIds: string[];
}): ReactElement {
  const ids = [...new Set([...(before?.scenes ?? []).map((shot) => shot.id), ...(after?.scenes ?? []).map((shot) => shot.id)])];
  const displayed = selectedIds.length ? ids.filter((id) => selectedIds.includes(id) || changedIds.includes(id)) : ids;
  const fields: { key: keyof SceneShot; label: string }[] = [
    { key: 'title', label: 'Название' },
    { key: 'original', label: 'Строка песни' },
    { key: 'sequence', label: 'Часть' },
    { key: 'start_frame', label: 'Первый кадр' },
    { key: 'end_frame_exclusive', label: 'Конец (не включая)' },
    { key: 'camera', label: 'Камера' },
    { key: 'action', label: 'Действие' },
    { key: 'continuity', label: 'Continuity' },
    { key: 'references', label: 'Референсы' },
    { key: 'lipsync', label: 'Lipsync' },
    { key: 'card', label: 'Карточка' },
    { key: 'state_from', label: 'Наследование состояния' },
    { key: 'state_changes', label: 'Изменения состояния' },
    { key: 'notes', label: 'Примечания' }
  ];
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Реестр сцен</Typography>
      {selectedIds.length > 0 && (
        <Alert severity="info">
          Разрешённые цели: {selectedIds.join(', ')}. Изменения состояния могут влиять на наследуемое состояние следующих планов; проверьте continuity ниже и в
          редакторе перед дальнейшим производством.
        </Alert>
      )}
      <ScenarioComparison
        title="Общие правила и шкала"
        fields={[
          { label: 'Визуальные правила', before: before?.visual_direction, after: after?.visual_direction },
          { label: 'Части', before: before?.sequences, after: after?.sequences },
          { label: 'Референсы', before: before?.references, after: after?.references },
          { label: 'Аудио', before: before?.audio, after: after?.audio },
          { label: 'Частота кадров', before: before?.fps, after: after?.fps }
        ]}
      />
      {displayed.map((id) => {
        const previous = before?.scenes.find((shot) => shot.id === id);
        const next = after?.scenes.find((shot) => shot.id === id);
        return (
          <ScenarioComparison
            key={id}
            title={`План ${id}${changedIds.includes(id) ? ' · изменён' : ''}`}
            fields={fields.map(({ key, label }) => ({ label, before: previous?.[key], after: next?.[key] }))}
          />
        );
      })}
    </Stack>
  );
}
