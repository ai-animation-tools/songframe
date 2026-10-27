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
    const chosen = await window.api.dialog.pickFolder({ title: 'Папка скачанной модели faster-whisper' });
    if (chosen) onPathChange(chosen);
  };
  return (
    <Stack spacing={2}>
      {!setup && !error ? (
        <Stack direction="row" spacing={1}>
          <CircularProgress size={18} />
          <Typography variant="body2">Проверяем CPU, память и доступность CUDA…</Typography>
        </Stack>
      ) : null}
      {error ? <Alert severity="warning">Не удалось получить рекомендацию: {error}</Alert> : null}
      {setup ? (
        <>
          <Alert severity="info">
            <strong>Рекомендуем {setup.recommended}.</strong> {setup.recommendation}
            <Typography variant="body2" sx={{ mt: 1 }}>
              {setup.hardware.cpuName}; RAM {setup.hardware.ramGiB.toFixed(1)} ГБ.
              {setup.hardware.gpuName ? ` NVIDIA: ${setup.hardware.gpuName}, ${(setup.hardware.vramMiB / 1024).toFixed(1)} ГБ видеопамяти.` : ''}
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              {setup.hardware.reason}
            </Typography>
          </Alert>
          {setup.gpuSuggestion && !setup.hardware.cudaReady ? (
            <Typography variant="body2">
              После настройки CUDA можно попробовать {setup.gpuSuggestion}. Нужны драйвер NVIDIA, cuBLAS для CUDA 12 и cuDNN 9.{' '}
              <Link href="https://github.com/SYSTRAN/faster-whisper#gpu" target="_blank" rel="noreferrer">
                Требования faster-whisper
              </Link>
              ,{' '}
              <Link
                href={
                  windows
                    ? 'https://docs.nvidia.com/cuda/cuda-installation-guide-microsoft-windows/'
                    : 'https://docs.nvidia.com/cuda/cuda-installation-guide-linux/'
                }
                target="_blank"
                rel="noreferrer"
              >
                CUDA для {windows ? 'Windows' : 'Linux'}
              </Link>
              ,{' '}
              <Link href="https://docs.nvidia.com/deeplearning/cudnn/installation/latest/" target="_blank" rel="noreferrer">
                установка cuDNN
              </Link>
              . После установки перезапустите приложение и нажмите «Обновить сведения».
            </Typography>
          ) : null}
          <TextField
            select
            label="Модель распознавания"
            value={selected}
            onChange={(event) => {
              const id = event.target.value as WhisperModelId;
              setSelected(id);
              onPathChange(setup.directories[id]);
            }}
            helperText="Это ориентир по ресурсам. Можно выбрать крупнее, но она потребует больше памяти и времени; точность песни не гарантируется."
          >
            {WHISPER_MODELS.map(({ id, size }) => (
              <MenuItem key={id} value={id}>
                {id} — {size}
                {id === setup.recommended ? ' (рекомендуется)' : ''}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="body2">{model.description}</Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {installed ? '' : `Размер загрузки: ${model.size}. `}Папка: {directory}
          </Typography>
          {/* Диагностика уже проверила файлы: установленной модели повторная загрузка не нужна. */}
          {installed ? (
            <Alert severity="success">
              Модель {selected} установлена.{usingDirectory ? ' Выбрана для распознавания.' : ''}
            </Alert>
          ) : (
            <WhisperModelDownload key={selected} model={selected} onDownloaded={downloaded} />
          )}
          <Stack direction="row" spacing={2} flexWrap="wrap">
            {installed && !usingDirectory ? (
              <Button size="small" startIcon={<CheckCircle />} onClick={() => onPathChange(directory)}>
                Использовать папку {selected}
              </Button>
            ) : null}
            <Link href={`https://huggingface.co/${model.repository}/tree/main`} target="_blank" rel="noreferrer">
              Файлы модели
            </Link>
          </Stack>
        </>
      ) : null}
      <Stack direction="row" spacing={1}>
        <TextField
          fullWidth
          label="Папка модели faster-whisper"
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder={setup?.directories[setup.recommended] ?? 'Выберите папку скачанной модели'}
          helperText="Можно выбрать любую локальную модель CTranslate2. Пусто: стандартная папка рекомендованной модели."
        />
        <Button startIcon={<FolderOpen />} onClick={pickFolder}>
          Обзор
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        «Обновить сведения» проверяет CPU, CUDA и стандартные папки моделей после ручной установки или изменения среды.
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
        Обновить сведения
      </Button>
    </Stack>
  );
}
