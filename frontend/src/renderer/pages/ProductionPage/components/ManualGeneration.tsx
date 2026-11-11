import { productionTexts } from '@shared/texts/production';
import { commonTexts } from '@shared/texts/common';
import { componentsTexts } from '@shared/texts/components';
/**
 * Ручная генерация речевого плана у провайдера без липсинка: приложение без агента собирает пакет (опора, срез речи,
 * видеопромпт), показывает его и пошаговую инструкцию провайдера из реестра, а созданное вне приложения видео
 * загружается в попытку с источником и необязательными стоимостью и примечанием. Файлы и проверки — у Go.
 */
import { Fragment, useState, type ReactElement, type ReactNode } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { mediaProviderInfo } from '@shared/media-providers';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import type { ManualCostUnit, ManualGeneration as ManualGenerationRecord, ManualVideo, PackageView } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { FileDropZone } from '../../../components/FileDropZone';
import { VIDEO_FILTER } from '../../../file-filters';
import { formatDateTime } from '../../../format';
import { useApp } from '../../../state';
import { BUSY_REASON } from '../constants';
import { PackageTextSection } from './PackageTextSection';
import { SpeechSlice } from './ProductionSpeechPanel';
import { ExternalLink } from '../../../components/ExternalLink';

const texts = productionTexts.manualGeneration;
const UNITS: ManualCostUnit[] = ['credits', 'RUB', 'USD'];

/** Имя файла без папок: пакет показывает файлы так, как их видит пользователь в «Открыть папку». */
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Шаг инструкции провайдера: {url} становится внешней ссылкой, {image} и {audio} — именами файлов пакета. */
function instructionStep(step: string, url: string, files: { image: string; audio: string }): ReactNode {
  return step.split(/(\{url\}|\{image\}|\{audio\})/).map((part, index) =>
    part === '{url}' ? (
      <ExternalLink key={index} href={url}>
        {url}
      </ExternalLink>
    ) : part === '{image}' ? (
      <Fragment key={index}>{files.image}</Fragment>
    ) : part === '{audio}' ? (
      <Fragment key={index}>{files.audio}</Fragment>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    )
  );
}

/** Строка сведений загруженного видео: источник, стоимость, время и исходное имя файла. */
export function manualGenerationLine(record: ManualGenerationRecord): string {
  const cost = record.cost ? texts.costValue(record.cost) : null;
  return texts.record({ source: record.source, cost, at: formatDateTime(record.attached_at), name: record.original_name });
}

/** Сведения загруженного видео ручной генерации на шаге результата. */
export function ManualGenerationInfo({ record }: { record: ManualGenerationRecord }): ReactElement {
  return (
    <Stack spacing={0.5}>
      <Typography variant="body2">{manualGenerationLine(record)}</Typography>
      {record.description ? (
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
          {record.description}
        </Typography>
      ) : null}
    </Stack>
  );
}

export function ManualGeneration({
  pkg,
  view,
  busy,
  busyReason = BUSY_REASON,
  onBuild,
  onAttach
}: {
  pkg: PackageView;
  view: ProductionWorkflowView | null;
  busy: boolean;
  busyReason?: string;
  onBuild(): void;
  onAttach(video: ManualVideo): void;
}): ReactElement {
  const { notify, describeError } = useApp();
  const [file, setFile] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [cost, setCost] = useState('');
  const [unit, setUnit] = useState<ManualCostUnit>('credits');
  const [note, setNote] = useState('');
  const request = pkg.request?.mode === 'manual' ? pkg.request : null;
  const provider = mediaProviderInfo(view?.videoProvider ?? request?.provider, 'video');
  const instruction = provider?.manualLipSync ?? null;

  if (!request) {
    const reason = busy ? busyReason : view ? (view.reasons.manual ?? null) : productionTexts.productionWorkflowPanel.loadingReason;
    return (
      <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="body2" color="text.secondary">
          {texts.description}
        </Typography>
        {pkg.speech ? <SpeechSlice speech={pkg.speech} /> : null}
        <ActionButton
          variant="contained"
          startIcon={<Inventory2OutlinedIcon />}
          title={texts.buildHint}
          disabled={busy || !view?.canBuildManual}
          disabledReason={reason}
          onClick={onBuild}
        >
          {texts.build}
        </ActionButton>
      </Stack>
    );
  }

  const image = request.inputs.find((input) => input.slot === 'image');
  const audio = request.inputs.find((input) => input.slot === 'audio');
  const files = { image: fileName(image?.path ?? ''), audio: fileName(audio?.path ?? '') };
  const speech = pkg.speech;
  const pending = request.attemptStatus === 'manual_pending';
  const costText = cost.trim().replace(',', '.');
  const costValue = costText === '' ? null : Number(costText);
  const costProblem = costValue !== null && (!Number.isFinite(costValue) || costValue < 0);
  const uploadReason = busy ? busyReason : !file ? texts.fileRequired : !source.trim() ? texts.sourceRequired : costProblem ? texts.costInvalid : null;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(request.promptText ?? '');
      notify(commonTexts.copied, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };
  const pick = async (): Promise<void> => {
    const [picked] = await window.api.dialog.pickFiles({ title: texts.zone, filters: VIDEO_FILTER, multiple: false });
    if (picked) setFile(picked);
  };

  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Typography variant="body2">{texts.built}</Typography>
        <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
          {image ? (
            <Typography component="li" variant="body2">
              {texts.input({ role: image.role ?? '', name: files.image })}
            </Typography>
          ) : null}
          {audio ? (
            <Typography component="li" variant="body2">
              {speech
                ? texts.speechInput({
                    role: audio.role ?? '',
                    name: files.audio,
                    seconds: productionTexts.productionSpeechPanel.seconds(speech.end - speech.start)
                  })
                : texts.input({ role: audio.role ?? '', name: files.audio })}
            </Typography>
          ) : null}
          <Typography component="li" variant="body2">
            {texts.promptInput}
          </Typography>
        </Stack>
      </Stack>
      {speech ? <SpeechSlice speech={speech} /> : null}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button startIcon={<FolderOpenIcon />} onClick={() => void window.api.shell.openPath(request.dir)}>
          {texts.openFolder}
        </Button>
        <Button startIcon={<ContentCopyIcon />} title={texts.copyHint} onClick={() => void copy()}>
          {texts.copy}
        </Button>
      </Stack>
      {request.promptText ? <PackageTextSection title={texts.prompt} text={request.promptText} maxHeight={220} /> : null}
      {instruction && provider ? (
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">{texts.instruction({ provider: provider.title })}</Typography>
          <Stack component="ol" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {instruction.steps.map((step) => (
              <Typography component="li" variant="body2" key={step}>
                {instructionStep(step, instruction.url, files)}
              </Typography>
            ))}
          </Stack>
        </Stack>
      ) : null}
      {pending ? (
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
          <TextField
            label={texts.source}
            required
            fullWidth
            value={source}
            onChange={(event) => setSource(event.target.value)}
            helperText={texts.sourceHint({ example: instruction?.sourceExample ?? null })}
          />
          <Stack direction="row" spacing={1}>
            <TextField
              label={texts.cost}
              value={cost}
              onChange={(event) => setCost(event.target.value)}
              error={costProblem}
              helperText={costProblem ? texts.costInvalid : texts.costHint}
              inputProps={{ inputMode: 'decimal' }}
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
          <Stack direction="row">
            <ActionButton
              variant="contained"
              startIcon={<UploadFileIcon />}
              disabled={!!uploadReason}
              disabledReason={uploadReason}
              onClick={() => {
                if (!file || uploadReason) return;
                onAttach({ file, source: source.trim(), costAmount: costValue, costUnit: costValue === null ? '' : unit, note: note.trim() });
              }}
            >
              {texts.upload}
            </ActionButton>
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );
}
