import type { ReactElement } from 'react';
import { Chip, type ChipProps } from '@mui/material';
import { PROJECT_STATE_LABELS, type ProjectState } from '@shared/types';

const COLORS: Record<ProjectState, ChipProps['color']> = {
  invalid: 'error',
  empty: 'default',
  sourced: 'info',
  timed: 'info',
  scripted: 'primary',
  in_production: 'warning',
  complete: 'success'
};

export function StateChip({ state, ...props }: { state: ProjectState } & Omit<ChipProps, 'label' | 'color'>): ReactElement {
  return <Chip label={PROJECT_STATE_LABELS[state]} color={COLORS[state]} variant={state === 'empty' ? 'outlined' : 'filled'} {...props} />;
}
