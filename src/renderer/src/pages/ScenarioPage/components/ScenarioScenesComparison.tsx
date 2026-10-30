import { scenarioTexts } from '@shared/texts/scenario';
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
    { key: 'title', label: scenarioTexts.fields.title },
    { key: 'original', label: scenarioTexts.fields.lyric },
    { key: 'sequence', label: scenarioTexts.fields.part },
    { key: 'start_frame', label: scenarioTexts.fields.firstFrame },
    { key: 'end_frame_exclusive', label: scenarioTexts.fields.endExclusive },
    { key: 'camera', label: scenarioTexts.fields.camera },
    { key: 'action', label: scenarioTexts.fields.action },
    { key: 'continuity', label: scenarioTexts.fields.continuity },
    { key: 'references', label: scenarioTexts.fields.references },
    { key: 'lipsync', label: scenarioTexts.fields.lipsync },
    { key: 'card', label: scenarioTexts.fields.card },
    { key: 'state_from', label: scenarioTexts.fields.stateFrom },
    { key: 'state_changes', label: scenarioTexts.fields.stateChanges },
    { key: 'derived_from', label: scenarioTexts.fields.derivedFrom },
    { key: 'notes', label: scenarioTexts.fields.notes }
  ];
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{scenarioTexts.fields.registry}</Typography>
      {selectedIds.length > 0 && <Alert severity="info">{scenarioTexts.comparison.allowedTargets({ ids: selectedIds })}</Alert>}
      <ScenarioComparison
        title={scenarioTexts.comparison.globalRules}
        defaultExpanded={false}
        fields={[
          { label: scenarioTexts.fields.visualRules, before: before?.visual_direction, after: after?.visual_direction },
          { label: scenarioTexts.fields.parts, before: before?.sequences, after: after?.sequences },
          { label: scenarioTexts.fields.references, before: before?.references, after: after?.references },
          { label: scenarioTexts.fields.audio, before: before?.audio, after: after?.audio },
          { label: scenarioTexts.fields.fps, before: before?.fps, after: after?.fps }
        ]}
      />
      {displayed.map((id) => {
        const previous = before?.scenes.find((shot) => shot.id === id);
        const next = after?.scenes.find((shot) => shot.id === id);
        return (
          <ScenarioComparison
            key={id}
            title={scenarioTexts.comparison.shotTitle({ id, changed: changedIds.includes(id) })}
            fields={fields.map(({ key, label }) => ({ label, before: previous?.[key], after: next?.[key] }))}
          />
        );
      })}
    </Stack>
  );
}
