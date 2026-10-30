import { timingTexts } from '@shared/texts/timing';
import { commonTexts } from '@shared/texts/common';
import { SlottedText } from '../../../components/SlottedText';
import { FolderOpen, Refresh, CheckCircle } from '@mui/icons-material';
/** Рекомендация модели, её загрузка и выбор локальной папки для распознавания. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, CircularProgress, Link, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { WHISPER_MODELS, type WhisperModelId, type WhisperSetup } from '@shared/whisper-models';
import { useApp } from '../../../state';
import { WhisperModelDownload } from './WhisperModelDownload';

interface Props {
  path: string;
  onPathChange(path: string): void;
}

export function WhisperModelSetup({ path, onPathChange }: Props): ReactElement {
  const { state } = useApp();
  const [setup, setSetup] = useState<WhisperSetup | null>(null);
  const [selected, setSelected] = useState<WhisperModelId>('medium');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const initialized = useRef(false);
  const initialPath = useRef(path);
  useEffect(() => {
    let active = true;
    window.api.timing
      .modelSetup()
      .then((result) => {
        if (!active) return;
        setSetup(result);
        // При повторном открытии сохраняем модель из поля пути; обновление файлов не сбрасывает выбор пользователя.
        if (!initialized.current) {
          initialized.current = true;
          setSelected(WHISPER_MODELS.find(({ id }) => result.directories[id] === initialPath.current)?.id ?? result.recommended);
        }
        setError('');
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const model = WHISPER_MODELS.find(({ id }) => id === selected)!;
  const directory = setup?.directories[selected] ?? '';
  const installed = setup?.installed[selected] ?? false;
  // Пустой путь использует рекомендованную модель; повторно выбирать её папку не требуется.
  const usingDirectory = path === directory || (!path && selected === setup?.recommended);
  const windows = (state?.platform ?? setup?.platform) === 'win32';
  const downloaded = useCallback(
    (folder: string): void => {
      onPathChange(folder);
      setRevision((value) => value + 1);
    },
    [onPathChange]
  );
  const pickFolder = async (): Promise<void> => {
    const chosen = await window.api.dialog.pickFolder({ title: timingTexts.modelFolderDialog });
    if (chosen) onPathChange(chosen);
  };
  return (
    <Stack spacing={2}>
      {!setup && !error ? (
        <Stack direction="row" spacing={1}>
          <CircularProgress size={18} />
          <Typography variant="body2">{timingTexts.checkingHardware}</Typography>
        </Stack>
      ) : null}
      {error ? <Alert severity="warning">{timingTexts.recommendationFailed({ reason: error })}</Alert> : null}
      {setup ? (
        <>
          <Alert severity="info">
            <strong>{timingTexts.recommendedModel({ model: setup.recommended })}</strong> {setup.recommendation}
            <Typography variant="body2" sx={{ mt: 1 }}>
              {timingTexts.hardwareSummary({
                cpuName: setup.hardware.cpuName,
                ramGiB: setup.hardware.ramGiB.toFixed(1),
                gpuName: setup.hardware.gpuName,
                vramGiB: setup.hardware.gpuName ? (setup.hardware.vramMiB / 1024).toFixed(1) : ''
              })}
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              {setup.hardware.reason}
            </Typography>
          </Alert>
          {setup.gpuSuggestion && !setup.hardware.cudaReady ? (
            <Typography variant="body2">
              <SlottedText
                text={timingTexts.cudaSetup}
                slots={{
                  model: setup.gpuSuggestion,
                  requirements: (
                    <Link href="https://github.com/SYSTRAN/faster-whisper#gpu" target="_blank" rel="noreferrer">
                      {timingTexts.whisperRequirements}
                    </Link>
                  ),
                  cuda: (
                    <Link
                      href={
                        windows
                          ? 'https://docs.nvidia.com/cuda/cuda-installation-guide-microsoft-windows/'
                          : 'https://docs.nvidia.com/cuda/cuda-installation-guide-linux/'
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {timingTexts.cudaPlatform({ platform: windows ? 'Windows' : 'Linux' })}
                    </Link>
                  ),
                  cudnn: (
                    <Link href="https://docs.nvidia.com/deeplearning/cudnn/installation/latest/" target="_blank" rel="noreferrer">
                      {timingTexts.cudnnInstallation}
                    </Link>
                  )
                }}
              />
            </Typography>
          ) : null}
          <TextField
            select
            label={timingTexts.recognitionModel}
            value={selected}
            onChange={(event) => {
              const id = event.target.value as WhisperModelId;
              setSelected(id);
              onPathChange(setup.directories[id]);
            }}
            helperText={timingTexts.modelHint}
          >
            {WHISPER_MODELS.map(({ id, size }) => (
              <MenuItem key={id} value={id}>
                {timingTexts.modelOption({ model: id, size, recommended: id === setup.recommended })}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="body2">{model.description}</Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {timingTexts.modelDirectory({ installed, size: model.size, directory })}
          </Typography>
          {/* Диагностика уже проверила файлы: установленной модели повторная загрузка не нужна. */}
          {installed ? (
            <Alert severity="success">{timingTexts.modelInstalled({ model: selected, selected: usingDirectory })}</Alert>
          ) : (
            <WhisperModelDownload key={selected} model={selected} onDownloaded={downloaded} />
          )}
          <Stack direction="row" spacing={2} flexWrap="wrap">
            {installed && !usingDirectory ? (
              <Button size="small" startIcon={<CheckCircle />} onClick={() => onPathChange(directory)}>
                {timingTexts.useModelDirectory({ model: selected })}
              </Button>
            ) : null}
            <Link href={`https://huggingface.co/${model.repository}/tree/main`} target="_blank" rel="noreferrer">
              {timingTexts.modelFiles}
            </Link>
          </Stack>
        </>
      ) : null}
      {/* Подсказка увеличивает высоту поля целиком: кнопку выравниваем по его верхнему краю и не сжимаем. */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          fullWidth
          sx={{ minWidth: 0 }}
          label={timingTexts.modelFolder}
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder={setup?.directories[setup.recommended] ?? timingTexts.chooseModelFolder}
          helperText={timingTexts.modelFolderHint}
        />
        <Button startIcon={<FolderOpen />} onClick={pickFolder} sx={{ flexShrink: 0, minHeight: 40 }}>
          {commonTexts.browse}
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {timingTexts.refreshHardwareHint}
      </Typography>
      <Button
        size="small"
        startIcon={<Refresh />}
        variant="contained"
        sx={{ alignSelf: 'flex-start' }}
        onClick={() => {
          setError('');
          setRevision((value) => value + 1);
        }}
      >
        {timingTexts.refreshHardware}
      </Button>
    </Stack>
  );
}
