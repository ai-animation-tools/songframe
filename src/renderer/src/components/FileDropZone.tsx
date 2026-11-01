/** Единая область выбора и перетаскивания файлов; сохранение остаётся за вызывающей страницей. */
import { componentsTexts } from '@shared/texts/components';
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
      notify(
        image ? componentsTexts.fileDrop.image.fromDisk : audio ? componentsTexts.fileDrop.audio.fromDisk : componentsTexts.fileDrop.text.fromDisk,
        'warning'
      );
      return;
    }
    if ((!multiple || audio) && files.length !== 1) {
      notify(image ? componentsTexts.fileDrop.image.single : audio ? componentsTexts.fileDrop.audio.single : componentsTexts.fileDrop.text.single, 'warning');
      return;
    }
    const extensions = (image ? IMAGE_FILTER : audio ? AUDIO_FILTER : TEXT_FILTER)[0].extensions;
    if (files.some((file) => !extensions.includes(file.name.split('.').pop()?.toLowerCase() ?? ''))) {
      notify(
        image ? componentsTexts.fileDrop.image.allowed : audio ? componentsTexts.fileDrop.audio.allowed : componentsTexts.fileDrop.text.allowed,
        'warning'
      );
      return;
    }
    try {
      // File.path больше не поддерживается Electron: нативный путь извлекает из File только preload.
      const paths = files.map((file) => window.api.shell.pathForFile(file));
      if (paths.some((path) => !path)) {
        notify(componentsTexts.fileDrop.noNativePath, 'warning');
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
      {/* Семантический пробел разделяет основной текст и подсказку: перенос CSS не разделяет слова для axe и чтения DOM. */}{' '}
      <Typography variant="caption" color={active ? 'primary' : 'text.secondary'} sx={{ display: 'block', mt: 1 }}>
        {hint ??
          (image ? (
            <>
              {onPick
                ? multiple
                  ? componentsTexts.fileDrop.image.pickMultiple
                  : componentsTexts.fileDrop.image.pickSingle
                : multiple
                  ? componentsTexts.fileDrop.image.dropMultiple
                  : componentsTexts.fileDrop.image.dropSingle}{' '}
              {componentsTexts.fileDrop.image.formats}
            </>
          ) : audio ? (
            onPick ? (
              componentsTexts.fileDrop.audio.pick
            ) : (
              componentsTexts.fileDrop.audio.drop
            )
          ) : onPick ? (
            componentsTexts.fileDrop.text.pick
          ) : (
            componentsTexts.fileDrop.text.drop
          ))}
      </Typography>
    </Box>
  );
}
