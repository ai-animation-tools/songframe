import { productionTexts } from '@shared/texts/production';
/**
 * «Изменить» на вопросе «Отправить»: пользователь выбирает модель команды видео и значения её выбираемых
 * параметров, приложение собирает запрос заново без агента. Варианты и текущий запрос читает Go
 * (productionWorkflow.requestOptions); длительность, разрешение, пропорции и входы остаются по плану.
 * Модели, которые план не примут, видны выключенными с причиной Go и идут после подходящих. Если в видеопромпте
 * есть метки героев, у модели видно, что станет с их образами, а запрос можно собрать заново и без изменений:
 * так он получает образы, привязанные после сборки.
 */
import { useEffect, useState, type ReactElement } from 'react';
import EditIcon from '@mui/icons-material/Edit';
import { Alert, Box, LinearProgress, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { mediaParameterLabel } from '@shared/media-providers';
import type { ProductionRequestChange, ProductionRequestOptions } from '@shared/production-workflow';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { useApp } from '../../../state';

type RequestModelOption = ProductionRequestOptions['models'][number];

const texts = productionTexts.requestChangeDialog;

/** Значения параметров сравниваются по JSON: Go отдаёт их типизированными (bool, число, строка). */
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Подпись значения в списке: логические — «Да»/«Нет», остальные как есть. */
function valueLabel(value: unknown): string {
  if (value === true) return texts.yes;
  if (value === false) return texts.no;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Параметры модели: допустимое прежнее значение сохраняется, иначе берётся первое из объявленных. */
function parametersFor(model: RequestModelOption | undefined, previous: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries((model?.parameters ?? []).map(({ name, values }) => [name, values.find((value) => same(value, previous[name])) ?? values[0]]));
}

export function RequestChangeDialog({
  project,
  shot,
  packageDir,
  provider,
  busy,
  onClose,
  onConfirm
}: {
  project: string;
  shot: string;
  packageDir: string;
  /** Провайдер видео проекта: подписи параметров из его реестра. */
  provider?: string | null;
  busy: boolean;
  onClose(): void;
  /** Собирает запрос заново; true — окно закрывается. Ошибку показывает панель плана. */
  onConfirm(change: ProductionRequestChange): Promise<boolean>;
}): ReactElement {
  const { describeError } = useApp();
  const [options, setOptions] = useState<ProductionRequestOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  useEffect(() => {
    let alive = true;
    window.api.productionWorkflow.requestOptions(project, shot, packageDir).then(
      (next) => {
        if (!alive) return;
        // Подходящие модели — первыми; порядок внутри групп — как у провайдера.
        const models = [...next.models].sort((left, right) => Number(!!left.unavailable) - Number(!!right.unavailable));
        setOptions({ ...next, models });
        const current = models.find((item) => item.id === next.model) ?? models.find((item) => !item.unavailable) ?? models[0];
        setModel(current?.id ?? '');
        setParameters(parametersFor(current, next.parameters));
      },
      (reason) => alive && setError(describeError(reason))
    );
    return () => {
      alive = false;
    };
  }, [describeError, packageDir, project, shot]);
  const selected = options?.models.find((item) => item.id === model);
  const unchanged = !!options && model === options.model && same(parameters, parametersFor(selected, options.parameters));
  const reason = !options ? texts.loading : selected?.unavailable ? selected.unavailable : unchanged && !options.marked ? texts.unchanged : null;
  return (
    <ConfirmationDialog
      open
      title={texts.title({ shot })}
      description={texts.description}
      confirmLabel={texts.confirm}
      confirmIcon={<EditIcon />}
      confirmDisabled={busy || !!reason}
      confirmDisabledReason={reason}
      closeDisabled={busy}
      cancelDisabled={busy}
      onClose={onClose}
      onConfirm={() => void onConfirm({ model, parameters }).then((done) => done && onClose())}
    >
      {busy ? <LinearProgress sx={{ mt: 2 }} /> : null}
      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : !options ? (
        <LinearProgress sx={{ mt: 2 }} aria-label={texts.loading} />
      ) : (
        <Stack spacing={2} sx={{ mt: 2 }}>
          <TextField
            select
            label={texts.model}
            value={model}
            disabled={busy}
            error={!!selected?.unavailable}
            helperText={selected?.unavailable ?? texts.modelHint}
            // Закрытое поле однострочное: причины недоступности видны только в списке.
            slotProps={{ select: { renderValue: (value) => String(value) } }}
            onChange={(event) => {
              const next = options.models.find((item) => item.id === event.target.value);
              setModel(event.target.value);
              setParameters((previous) => parametersFor(next, previous));
            }}
          >
            {options.models.map((item) => (
              <MenuItem key={item.id} value={item.id} disabled={!!item.unavailable}>
                <Box sx={{ whiteSpace: 'normal' }}>
                  <Typography variant="body2">{item.id}</Typography>
                  {item.unavailable || item.looks ? (
                    <Typography variant="caption" color="text.secondary">
                      {item.unavailable ?? item.looks}
                    </Typography>
                  ) : null}
                </Box>
              </MenuItem>
            ))}
          </TextField>
          {selected?.looks && !selected.unavailable ? <Alert severity="warning">{selected.looks}</Alert> : null}
          {selected?.parameters.length ? (
            selected.parameters.map(({ name, values }) => (
              <TextField
                key={name}
                select
                label={mediaParameterLabel(provider, name)}
                value={String(
                  Math.max(
                    0,
                    values.findIndex((value) => same(value, parameters[name]))
                  )
                )}
                disabled={busy}
                onChange={(event) => setParameters((previous) => ({ ...previous, [name]: values[Number(event.target.value)] }))}
              >
                {values.map((value, index) => (
                  <MenuItem key={index} value={String(index)}>
                    {valueLabel(value)}
                  </MenuItem>
                ))}
              </TextField>
            ))
          ) : (
            <Alert severity="info">{texts.noParameters}</Alert>
          )}
        </Stack>
      )}
    </ConfirmationDialog>
  );
}
