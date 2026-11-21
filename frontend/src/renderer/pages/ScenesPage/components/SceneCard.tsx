import { scenesTexts } from '@shared/texts/scenes';
import type { ReactElement } from 'react';
import { Chip } from '@mui/material';
import type { DashboardShot } from '@shared/types';
import { ShotCard } from '../../../components/ShotCard';

/** Карточка сцены: общая карточка плана с первой опорой принятого комплекта или попытки. */
export function SceneCard({ shot, selected, onSelect }: { shot: DashboardShot; selected: boolean; onSelect(id: string): void }): ReactElement {
  return (
    <ShotCard
      shot={shot}
      imagePath={shot.thumbnail}
      chips={
        (shot.state === 'completed' || shot.state === 'stale') && !shot.asset?.video ? (
          <Chip size="small" color="warning" label={scenesTexts.missingVideo} sx={{ height: 18 }} />
        ) : null
      }
      selected={selected}
      onSelect={onSelect}
    />
  );
}
