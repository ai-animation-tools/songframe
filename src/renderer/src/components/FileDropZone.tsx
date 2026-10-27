/** Единая область выбора и перетаскивания файлов; сохранение остаётся за вызывающей страницей. */
import { useRef, useState, type DragEvent, type ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import { useApp } from '../state';
import { AUDIO_FILTER, IMAGE_FILTER, TEXT_FILTER } from '../file-filters';

interface Props {
  label: string;
  kind: 'image' | 'text' | 'audio';
  multiple?: boolean;
  hint?: string;
  message: string;
  onFiles(paths: string[]): void | Promise<void>;
  onPick?: () => void | Promise<void>;
}

export function FileDropZone({ label, kind, multiple = false, hint, message, onFiles, onPick }: Props): ReactElement {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const { notify, describeError } = useApp();
  const image = kind === 'image';
  const audio = kind === 'audio';
  const pick = async (): Promise<void> => {
    try {
      await onPick?.();
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };
  const drop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current = 0;
    setActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      notify(image ? 'Перетащите файл изображения с диска.' : audio ? 'Перетащите MP3 с диска.' : 'Перетащите текстовый файл с диска.', 'warning');
      return;
    }
    if ((!multiple || audio) && files.length !== 1) {
      notify(image ? 'Для обложки выберите одно изображение.' : audio ? 'Для трека выберите один MP3.' : 'Перетащите один текстовый файл.', 'warning');
      return;
    }
    const extensions = (image ? IMAGE_FILTER : audio ? AUDIO_FILTER : TEXT_FILTER)[0].extensions;
    if (files.some((file) => !extensions.includes(file.name.split('.').pop()?.toLowerCase() ?? ''))) {
      notify(image ? 'Допустимы изображения PNG, JPG и WebP.' : audio ? 'Для трека допустим только файл MP3.' : 'Допустимы файлы TXT и MD.', 'warning');
      return;
    }
    try {
      // File.path больше не поддерживается Electron: нативный путь извлекает из File только preload.
      const paths = files.map((file) => window.api.shell.pathForFile(file));
      if (paths.some((path) => !path)) {
        notify('Перетащите сохранённый файл с диска или выберите его через диалог.', 'warning');
        return;
      }
      await onFiles([...new Set(paths)]);
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };
  return (
    <Box
      role={onPick ? 'button' : 'region'}
      aria-label={label}
      tabIndex={onPick ? 0 : undefined}
      onClick={onPick ? pick : undefined}
      onKeyDown={(event) => {
        // Enter и пробел открывают выбор файлов, как у обычной кнопки.
        if (!onPick || event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        void pick();
      }}
      onDrop={drop}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        depth.current++;
        setActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setActive(false);
      }}
      sx={{
        p: 1.5,
        minHeight: 160,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        border: '1px dashed',
        borderRadius: 1.5,
        borderColor: active ? 'primary.main' : 'divider',
        bgcolor: active ? 'action.selected' : undefined,
        cursor: onPick ? 'pointer' : undefined,
        ...(onPick
          ? {
              '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
            }
          : {})
      }}
    >
      {/* Основной текст центрируется вместе со значком, подсказка остаётся у нижнего края. */}
      <Box sx={{ display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 0.75, py: 1 }}>
        <CloudUploadOutlinedIcon color="primary" fontSize="large" />
        <Typography color="primary" sx={{ textAlign: 'center' }}>
          {message}
        </Typography>
      </Box>
      <Typography variant="caption" color={active ? 'primary' : 'text.secondary'} sx={{ display: 'block', mt: 1 }}>
        {hint ??
          (image ? (
            <>
              {onPick
                ? multiple
                  ? 'Перетащите изображения сюда или нажмите, чтобы выбрать файлы.'
                  : 'Перетащите изображение сюда или нажмите, чтобы выбрать файл.'
                : multiple
                  ? 'Перетащите изображения сюда.'
                  : 'Перетащите изображение сюда.'}{' '}
              PNG, JPG, WebP.
            </>
          ) : audio ? (
            onPick ? (
              'Перетащите MP3 сюда или нажмите, чтобы выбрать файл.'
            ) : (
              'Перетащите MP3 сюда.'
            )
          ) : onPick ? (
            'Перетащите сюда TXT или MD либо нажмите, чтобы выбрать файл.'
          ) : (
            'Перетащите сюда TXT или MD.'
          ))}
      </Typography>
    </Box>
  );
}
