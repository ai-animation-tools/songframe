import { schemesTexts } from '@shared/texts/schemes';
import { useEffect, useState, type ReactElement } from 'react';
import { Box, Checkbox, FormControlLabel, IconButton, InputAdornment, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { SchemeLocation, SchemeObject, SchemePoint, SchemeShape } from '@shared/schemes';
import { ActionButton } from '../../../components/ActionButton';
import { objectColor } from '@shared/scheme-editing';

/**
 * Сетка полей свойств: колонки не уже 140 px. В боковой панели справа от холста — две колонки, под широким
 * холстом — сколько поместится. Длинные поля занимают две колонки, подсказки — всю строку.
 */
const FIELDS_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 1.5, alignItems: 'start' } as const;
const WIDE_FIELD = { gridColumn: 'span 2' } as const;
const FULL_ROW = { gridColumn: '1 / -1' } as const;

/**
 * Числовое поле с собственной строкой ввода: промежуточные «-» и «1.» не сбрасываются, число уходит наверх,
 * когда строка разбирается. optional — пустая строка означает «нет значения».
 */
function NumberField({
  label,
  value,
  onChange,
  optional = false,
  helperText
}: {
  label: string;
  value: number | undefined;
  onChange(value: number | undefined): void;
  optional?: boolean;
  helperText?: string;
}): ReactElement {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setText((current) => (Number(current) === value && current !== '' ? current : value === undefined ? '' : String(value)));
  }, [value]);
  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={text}
      helperText={helperText}
      fullWidth
      inputProps={{ step: 0.1 }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === '') {
          if (optional) onChange(undefined);
          return;
        }
        const number = Number(next);
        if (Number.isFinite(number)) onChange(number);
      }}
    />
  );
}

/** Поля геометрии по типу фигуры: центр, размеры и поворот, координаты точки, ширина и флаги линии. */
function ShapeFields({ shape, onChange }: { shape: SchemeShape; onChange(shape: SchemeShape): void }): ReactElement {
  const pair = (point: SchemePoint, index: 0 | 1, value: number | undefined): SchemePoint =>
    index === 0 ? [value ?? point[0], point[1]] : [point[0], value ?? point[1]];
  switch (shape.type) {
    case 'rect':
    case 'ellipse': {
      const size = shape.type === 'rect' ? shape.size : shape.radii;
      const sized = (value: SchemePoint): SchemeShape => (shape.type === 'rect' ? { ...shape, size: value } : { ...shape, radii: value });
      return (
        <Box sx={FIELDS_GRID}>
          <NumberField
            label={schemesTexts.centerX}
            value={shape.center[0]}
            onChange={(value) => onChange({ ...shape, center: pair(shape.center, 0, value) })}
          />
          <NumberField
            label={schemesTexts.centerY}
            value={shape.center[1]}
            onChange={(value) => onChange({ ...shape, center: pair(shape.center, 1, value) })}
          />
          <NumberField
            label={shape.type === 'rect' ? schemesTexts.width : schemesTexts.radiusX}
            value={size[0]}
            onChange={(value) => value !== undefined && value > 0 && onChange(sized(pair(size, 0, value)))}
          />
          <NumberField
            label={shape.type === 'rect' ? schemesTexts.depth : schemesTexts.radiusY}
            value={size[1]}
            onChange={(value) => value !== undefined && value > 0 && onChange(sized(pair(size, 1, value)))}
          />
          <NumberField label={schemesTexts.rotation} value={shape.rotation ?? 0} onChange={(value) => onChange({ ...shape, rotation: value ?? 0 })} />
        </Box>
      );
    }
    case 'point':
      return (
        <Box sx={FIELDS_GRID}>
          <NumberField label={schemesTexts.pointX} value={shape.at[0]} onChange={(value) => onChange({ ...shape, at: pair(shape.at, 0, value) })} />
          <NumberField label={schemesTexts.pointY} value={shape.at[1]} onChange={(value) => onChange({ ...shape, at: pair(shape.at, 1, value) })} />
        </Box>
      );
    case 'line':
      return (
        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 1 }}>
          <NumberField
            label={schemesTexts.lineWidth}
            value={shape.width}
            optional
            helperText={schemesTexts.lineWidthHint}
            onChange={(value) => onChange({ ...shape, width: value !== undefined && value > 0 ? value : undefined })}
          />
          <FormControlLabel
            control={<Checkbox checked={!!shape.smooth} onChange={(event) => onChange({ ...shape, smooth: event.target.checked })} />}
            label={schemesTexts.smooth}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={!!shape.closed}
                disabled={shape.points.length < 3}
                onChange={(event) => onChange({ ...shape, closed: event.target.checked })}
              />
            }
            label={schemesTexts.closed}
          />
          <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
            {schemesTexts.vertices({ count: shape.points.length })}
          </Typography>
        </Stack>
      );
    case 'polygon':
      return (
        <Typography variant="body2" color="text.secondary">
          {schemesTexts.vertices({ count: shape.points.length })}
        </Typography>
      );
  }
}

/** Свойства выбранного объекта схемы: название, высота, цвет, связь с локацией и геометрия; удаление объекта. */
export function ObjectProperties({
  object,
  locations,
  onChange,
  onDelete
}: {
  object: SchemeObject | null;
  locations: readonly SchemeLocation[];
  onChange(object: SchemeObject): void;
  onDelete(): void;
}): ReactElement {
  if (!object) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {schemesTexts.noSelection}
        </Typography>
      </Paper>
    );
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Box sx={FIELDS_GRID}>
          <TextField
            size="small"
            label={schemesTexts.objectName}
            value={object.name}
            error={!object.name.trim()}
            helperText={schemesTexts.objectNameHint}
            onChange={(event) => onChange({ ...object, name: event.target.value })}
            sx={WIDE_FIELD}
          />
          <NumberField
            label={schemesTexts.height}
            value={object.height}
            optional
            onChange={(value) => onChange({ ...object, height: value !== undefined && value > 0 ? value : undefined })}
          />
          {/* Цвет нужен только человеку на холсте: любой из системной палитры, сброс — к цвету по умолчанию. */}
          <TextField
            size="small"
            type="color"
            label={schemesTexts.color}
            value={objectColor(object)}
            onChange={(event) => onChange({ ...object, color: event.target.value })}
            slotProps={{
              htmlInput: { sx: { cursor: 'pointer', height: 24, p: 0.5 } },
              input: {
                endAdornment: object.color ? (
                  <InputAdornment position="end">
                    <Tooltip title={schemesTexts.colorReset}>
                      <IconButton size="small" edge="end" aria-label={schemesTexts.colorReset} onClick={() => onChange({ ...object, color: undefined })}>
                        <RestartAltIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : undefined
              }
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ ...FULL_ROW, mt: -0.75 }}>
            {schemesTexts.heightHint}
          </Typography>
          <TextField
            select
            size="small"
            label={schemesTexts.entity}
            value={object.entity ?? ''}
            helperText={schemesTexts.entityHint}
            onChange={(event) => onChange({ ...object, entity: event.target.value || undefined })}
            sx={WIDE_FIELD}
          >
            <MenuItem value="">{schemesTexts.entityNone}</MenuItem>
            {locations.map((location) => (
              <MenuItem key={location.id} value={location.id}>
                {location.name || location.id}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        <Typography variant="subtitle2">{schemesTexts.shapeType({ type: schemesTexts.tools[object.shape.type] })}</Typography>
        <ShapeFields shape={object.shape} onChange={(shape) => onChange({ ...object, shape })} />
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
          <ActionButton color="error" startIcon={<DeleteOutlineIcon />} onClick={onDelete}>
            {schemesTexts.deleteObject}
          </ActionButton>
          <Typography variant="body2" color="text.secondary">
            {schemesTexts.deleteObjectHint}
          </Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}
