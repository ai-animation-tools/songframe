import type { ReactElement } from 'react';
import { Autocomplete, Box, Chip, Paper, TextField, Typography } from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { CastProperty } from '@shared/types';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { propertyLabelProblem, propertyValues } from '../properties';

interface CastPropertyRowProps {
  property: CastProperty;
  /** Новое несохранённое свойство: только у него можно менять код. */
  fresh: boolean;
  keyProblem: string | null;
  kindLabel: string;
  /** Сколько сущностей типа уже хранят значение под этим кодом в начальном состоянии. */
  usage: number;
  first: boolean;
  last: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onChange: (patch: Partial<CastProperty>) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
}

const entitiesGenitive = (count: number): string => (count % 10 === 1 && count % 100 !== 11 ? 'сущности' : 'сущностей');

/** Строка словаря: краткая сводка с действиями записи и раскрываемые поля свойства. */
export function CastPropertyRow({
  property,
  fresh,
  keyProblem,
  kindLabel,
  usage,
  first,
  last,
  expanded,
  onExpandedChange,
  onChange,
  onMove,
  onRemove
}: CastPropertyRowProps): ReactElement {
  const name = property.label.trim() || property.key || 'без подписи';
  const labelProblem = propertyLabelProblem(property.label);
  const checklistWithoutValue = Boolean(property.checklist?.trim()) && !property.checklist?.includes('{value}');
  const removeDescription = fresh
    ? 'Новое свойство ещё не сохранено и будет убрано из словаря.'
    : `Свойство исчезнет из словаря типа «${kindLabel}»: в редакторах состояния пропадут его подпись, подсказка, варианты и пункт проверки. ` +
      `Уже записанные значения в начальном состоянии сущностей и изменениях состояния планов не удаляются и останутся под кодом ${property.key} как свои свойства без подписи.` +
      (usage ? ` Сейчас значение записано в начальном состоянии у ${usage} ${entitiesGenitive(usage)} этого типа.` : '');
  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
      {/* Сводка переносится по ширине: действия записи остаются в строке справа. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flex: 1, minWidth: 0 }}>
          <Typography fontWeight={600} noWrap title={name} sx={{ minWidth: 0 }}>
            {name}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            title={fresh ? undefined : 'Код не меняется: под ним хранятся значения состояния.'}
            sx={{ fontFamily: 'monospace', flexShrink: 0 }}
          >
            {property.key}
          </Typography>
        </Box>
        {fresh ? <Chip size="small" variant="outlined" color="success" label="новое, не сохранено" /> : null}
        {property.values?.length ? <Chip size="small" variant="outlined" label={`вариантов: ${property.values.length}`} /> : null}
        {property.checklist?.trim() ? <Chip size="small" variant="outlined" label="есть проверка" /> : null}
        {keyProblem || labelProblem ? <Chip size="small" variant="outlined" color="error" label="нужно исправить" /> : null}
        <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <ActionIconButton
            size="small"
            aria-label={`Поднять свойство «${name}»`}
            title="Поднять выше: порядок задаёт порядок полей в редакторах состояния"
            disabled={first}
            disabledReason="Свойство уже первое в словаре."
            onClick={() => onMove(-1)}
          >
            <ArrowUpwardIcon fontSize="small" />
          </ActionIconButton>
          <ActionIconButton
            size="small"
            aria-label={`Опустить свойство «${name}»`}
            title="Опустить ниже: порядок задаёт порядок полей в редакторах состояния"
            disabled={last}
            disabledReason="Свойство уже последнее в словаре."
            onClick={() => onMove(1)}
          >
            <ArrowDownwardIcon fontSize="small" />
          </ActionIconButton>
          <ActionIconButton
            size="small"
            aria-label={expanded ? `Свернуть свойство «${name}»` : `Изменить свойство «${name}»`}
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? <ExpandLessIcon fontSize="small" /> : <EditOutlinedIcon fontSize="small" />}
          </ActionIconButton>
          <DestructiveButton icon label={`Удалить свойство «${name}»`} description={removeDescription} onConfirm={onRemove}>
            <DeleteOutlineIcon fontSize="small" />
          </DestructiveButton>
        </Box>
      </Box>
      {expanded ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            '@container workspace (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.5,
            mt: 1.5,
            alignItems: 'start'
          }}
        >
          {fresh ? (
            <TextField
              size="small"
              label="Код"
              required
              value={property.key}
              onChange={(e) => onChange({ key: e.target.value })}
              error={Boolean(keyProblem)}
              helperText={keyProblem ?? 'Латиницей; под этим кодом значение хранится в состоянии сущностей и планов. После сохранения код не меняется.'}
              slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: 'monospace' } } }}
              sx={{ gridColumn: '1 / -1' }}
            />
          ) : null}
          <TextField
            size="small"
            label="Подпись"
            required
            value={property.label}
            onChange={(e) => onChange({ label: e.target.value })}
            error={Boolean(labelProblem)}
            helperText={labelProblem ?? 'Название поля в редакторах начального состояния («Кастинг») и изменений состояния плана («Сценарий»).'}
          />
          <TextField
            size="small"
            label="Подсказка"
            value={property.hint ?? ''}
            onChange={(e) => onChange({ hint: e.target.value })}
            helperText="Серая подсказка в пустом поле состояния."
          />
          <Autocomplete
            multiple
            freeSolo
            // Набранный, но не подтверждённый Enter вариант не теряется при уходе из поля.
            autoSelect
            size="small"
            options={[]}
            value={property.values ?? []}
            onChange={(_e, next) => onChange({ values: propertyValues(next) })}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Варианты значений"
                placeholder={property.values?.length ? undefined : 'вариант и Enter'}
                helperText="Выпадающий список поля состояния; своё значение вписать всё равно можно. Введите вариант и нажмите Enter, лишний уберите крестиком."
              />
            )}
          />
          <TextField
            size="small"
            label="Шаблон проверки"
            value={property.checklist ?? ''}
            onChange={(e) => onChange({ checklist: e.target.value })}
            placeholder="Опора и глубина погружения: {value}?"
            helperText={
              'Пункт «что сверить» во врезке непрерывности: {value} заменяется значением состояния. Пусто — пункта нет.' +
              (checklistWithoutValue ? ' В шаблоне нет {value}: пункт выйдет без записанного значения.' : '')
            }
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Box>
      ) : null}
    </Paper>
  );
}
