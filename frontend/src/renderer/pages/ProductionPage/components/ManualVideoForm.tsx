import { productionTexts } from '@shared/texts/production';
import { componentsTexts } from '@shared/texts/components';
/**
 * Форма видео, созданного вне приложения: файл MP4 (перетаскиванием или выбором), обязательный источник и необязательные
 * стоимость с единицей и примечание. Общая для пакета ручной генерации и своего видео плана; формат файла и запись
 * проверяет Go, здесь — только то, что объясняет недоступность кнопки загрузки. В диалоге кнопку загрузки даёт сам диалог:
 * форма без onSubmit сообщает готовое видео или причину недоступности через onChange.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import type { ManualCostUnit, ManualVideo } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { FileDropZone } from '../../../components/FileDropZone';
import { VIDEO_FILTER } from '../../../file-filters';

const texts = productionTexts.manualGeneration;
const UNITS: ManualCostUnit[] = ['credits', 'RUB', 'USD'];

/** Имя файла без папок: так файл виден в проводнике. */
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export function ManualVideoForm({
  busy,
  busyReason,
  sourceHint,
  onSubmit,
  onChange
}: {
  busy: boolean;
  busyReason: string;
  /** Подсказка поля «Источник» с примерами. */
  sourceHint: string;
  /** Своя кнопка «Загрузить видео»; без обработчика кнопки нет — её даёт окно вокруг формы. */
  onSubmit?(video: ManualVideo): void;
  /** Готовое к загрузке видео либо null и причина, почему загрузить его пока нельзя. */
  onChange?(video: ManualVideo | null, problem: string | null): void;
}): ReactElement {
  const [file, setFile] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [cost, setCost] = useState('');
  // Поле числа отдаёт пустую строку и для пустого поля, и для текста, который не разобрало: без этого признака
  // неразобранная стоимость молча пропала бы из записи.
  const [costUnreadable, setCostUnreadable] = useState(false);
  const [unit, setUnit] = useState<ManualCostUnit>('credits');
  const [note, setNote] = useState('');
  const costText = cost.trim();
  const costValue = costText === '' ? null : Number(costText);
  // Стоимость — целое неотрицательное число в выбранной единице: дробных кредитов, рублей и долларов у генераций нет.
  const costProblem = costUnreadable || (costValue !== null && (!Number.isInteger(costValue) || costValue < 0));
  const uploadReason = busy ? busyReason : !file ? texts.fileRequired : !source.trim() ? texts.sourceRequired : costProblem ? texts.costInvalid : null;
  const video: ManualVideo | null =
    file && !uploadReason ? { file, source: source.trim(), costAmount: costValue, costUnit: costValue === null ? '' : unit, note: note.trim() } : null;
  const videoKey = video ? JSON.stringify(video) : null;
  useEffect(() => {
    onChange?.(video, uploadReason);
    // Сообщаем только смену содержимого, а не каждый новый объект обработчика.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, uploadReason]);
  const pick = async (): Promise<void> => {
    const [picked] = await window.api.dialog.pickFiles({ title: texts.zone, filters: VIDEO_FILTER, multiple: false });
    if (picked) setFile(picked);
  };
  return (
    <Stack spacing={1.5}>
      {/* Выбранный файл — заметная плашка вместо зоны: по ней сразу видно, что видео готово к загрузке. */}
      {file ? (
        <Alert
          severity="success"
          action={
            <Button color="inherit" size="small" startIcon={<FolderOpenIcon />} onClick={() => void pick()}>
              {texts.replace}
            </Button>
          }
        >
          <Typography variant="body1" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
            {texts.chosen({ name: fileName(file) })}
          </Typography>
        </Alert>
      ) : (
        // Доступное имя повторяет видимый текст зоны вместе с подсказкой, как у зон страницы «Исходники».
        <FileDropZone
          label={`${texts.zone} ${componentsTexts.fileDrop.video.pick}`}
          kind="video"
          message={texts.zone}
          hint={componentsTexts.fileDrop.video.pick}
          onFiles={([path]) => setFile(path ?? null)}
          onPick={pick}
        />
      )}
      <TextField label={texts.source} required fullWidth value={source} onChange={(event) => setSource(event.target.value)} helperText={sourceHint} />
      <Stack direction="row" spacing={1}>
        <TextField
          type="number"
          label={texts.cost}
          value={cost}
          onChange={(event) => {
            setCost(event.target.value);
            setCostUnreadable((event.target as HTMLInputElement).validity.badInput);
          }}
          error={costProblem}
          helperText={costProblem ? texts.costInvalid : texts.costHint}
          // Верхней границы нет: атрибут max не задаётся.
          inputProps={{ min: 0, step: 1 }}
          sx={{ width: 180 }}
        />
        <TextField select label={texts.unit} value={unit} onChange={(event) => setUnit(event.target.value as ManualCostUnit)} sx={{ width: 140 }}>
          {UNITS.map((value) => (
            <MenuItem key={value} value={value}>
              {texts.units[value]}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <TextField
        label={texts.note}
        multiline
        fullWidth
        minRows={2}
        maxRows={8}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        helperText={texts.noteHint}
      />
      {onSubmit ? (
        <Stack direction="row">
          <ActionButton
            variant="contained"
            startIcon={<UploadFileIcon />}
            disabled={!!uploadReason}
            disabledReason={uploadReason}
            onClick={() => {
              if (video) onSubmit(video);
            }}
          >
            {texts.upload}
          </ActionButton>
        </Stack>
      ) : null}
    </Stack>
  );
}
