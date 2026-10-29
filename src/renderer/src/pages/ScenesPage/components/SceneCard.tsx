import type { ReactElement } from 'react';
import { Chip } from '@mui/material';
import type { DashboardShot } from '@shared/types';
import { ShotCard } from '../../../components/ShotCard';
import { getSceneVideoPath } from '../helpers';

/** Карточка сцены: общая карточка плана с принятым видео или миниатюрой опор. */
export function SceneCard({ shot, selected, onSelect }: { shot: DashboardShot; selected: boolean; onSelect(id: string): void }): ReactElement {
  return (
    <ShotCard
      shot={shot}
      videoPath={getSceneVideoPath(shot)}
      imagePath={shot.thumbnail}
      chips={
        (shot.state === 'completed' || shot.state === 'stale') && !shot.asset?.video ? (
          <Chip size="small" color="warning" label="Видео отсутствует" sx={{ height: 18 }} />
        ) : null
      }
      selected={selected}
      onSelect={onSelect}
    />
  );
}
