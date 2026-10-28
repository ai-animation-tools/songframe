/** Человекочитаемый показ значений: текст с лёгкой разметкой, списки и объекты реестра без JSON. */
import type { ReactElement } from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import { inline, Prose } from './Prose';

/** Подписи известных ключей реестра, кастинга и трактовки; неизвестные ключи показываются как есть. */
const KEY_LABELS: Record<string, string> = {
  id: 'Код',
  title: 'Название',
  direction: 'Действие',
  start: 'Начало, с',
  end: 'Конец, с',
  entities: 'Участники',
  lipsync: 'Липсинк',
  max_shot_seconds: 'Максимум плана, с',
  name: 'Имя',
  short_name: 'Краткое имя',
  path: 'Файл',
  end_seconds: 'Конец песни, с',
  primary_reference: 'Главный референс',
  scene: 'План',
  phase: 'Момент',
  before: 'На первый кадр',
  after: 'На последний кадр',
  key: 'Ключ',
  label: 'Подпись',
  hint: 'Подсказка',
  values: 'Типовые значения',
  checklist: 'Проверка по кадру'
};
const PHASES: Record<string, string> = { before: 'состояние на первый кадр', after: 'состояние на последний кадр', same: 'то же состояние' };

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key.replace(/_/g, ' ');
}

function isPrimitiveArray(value: unknown[]): value is (string | number | boolean)[] {
  return value.every((item) => ['string', 'number', 'boolean'].includes(typeof item));
}

function Pairs({ value }: { value: Record<string, unknown> }): ReactElement {
  const entries = Object.entries(value);
  if (!entries.length)
    return (
      <Typography variant="body2" color="text.secondary">
        пусто
      </Typography>
    );
  return (
    <Stack spacing={0.5}>
      {entries.map(([key, item]) => (
        <Box key={key} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
            {keyLabel(key)}:
          </Typography>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <ReadableValue value={item} nested />
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

/** Состояние сущностей и его изменения: сущность, затем свойства; null означает снятие свойства. */
function StateTable({ value }: { value: Record<string, Record<string, unknown>> }): ReactElement {
  const entities = Object.entries(value);
  if (!entities.length)
    return (
      <Typography variant="body2" color="text.secondary">
        без изменений
      </Typography>
    );
  return (
    <Stack spacing={0.5}>
      {entities.map(([entity, props]) => (
        <Typography key={entity} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          <b>{entity}:</b>{' '}
          {Object.entries(props)
            .map(([key, item]) => `${keyLabel(key)}: ${item === null ? 'снять' : String(item)}`)
            .join('; ') || 'без свойств'}
        </Typography>
      ))}
    </Stack>
  );
}

function isStateMap(value: Record<string, unknown>): value is Record<string, Record<string, unknown>> {
  const entries = Object.values(value);
  return (
    entries.length > 0 &&
    entries.every(
      (item) => typeof item === 'object' && item !== null && !Array.isArray(item) && Object.values(item).every((v) => v === null || typeof v === 'string')
    )
  );
}

export function ReadableValue({ value, nested = false }: { value: unknown; nested?: boolean }): ReactElement {
  if (value === null || value === undefined || value === '')
    return (
      <Typography variant="body2" color="text.secondary">
        {nested ? 'нет' : '—'}
      </Typography>
    );
  if (typeof value === 'boolean') return <Typography variant="body2">{value ? 'Да' : 'Нет'}</Typography>;
  if (typeof value === 'number') return <Typography variant="body2">{value}</Typography>;
  if (typeof value === 'string')
    return value.includes('\n') || /\*\*|^#/.test(value) ? (
      <Prose text={value} />
    ) : (
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {inline(value)}
      </Typography>
    );
  if (Array.isArray(value)) {
    if (!value.length)
      return (
        <Typography variant="body2" color="text.secondary">
          пусто
        </Typography>
      );
    if (isPrimitiveArray(value))
      return (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          {value.map((item, index) => (
            <Chip key={`${item}-${index}`} size="small" variant="outlined" label={String(item)} />
          ))}
        </Box>
      );
    return (
      <Stack spacing={1}>
        {value.map((item, index) => (
          <Box key={index} sx={{ pl: 1, borderLeft: 2, borderColor: 'divider' }}>
            <ReadableValue value={item} nested />
          </Box>
        ))}
      </Stack>
    );
  }
  const record = value as Record<string, unknown>;
  // Наследование состояния: { scene, phase } читается одной фразой.
  if (typeof record.scene === 'string' && typeof record.phase === 'string' && Object.keys(record).length === 2)
    return (
      <Typography variant="body2">
        от плана {record.scene}: {PHASES[record.phase] ?? record.phase}
      </Typography>
    );
  if (isStateMap(record)) return <StateTable value={record} />;
  return <Pairs value={record} />;
}
