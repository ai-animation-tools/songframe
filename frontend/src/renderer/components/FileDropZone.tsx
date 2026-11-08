/**
 * Единая область выбора и перетаскивания файлов; сохранение остаётся за вызывающей страницей.
 *
 * DOM-событие drop не даёт абсолютного пути файла, поэтому в Wails пути
 * перетащенных файлов приходят из Go событием `shell.onFilesDropped` по id элемента с атрибутом
 * `data-file-drop-target`, уже после DOM drop. Поэтому DOM-события только подсвечивают область и
 * запрещают навигацию браузера, а проверки количества и расширений выполняются по полученным путям.
 * DOM drop не останавливает всплытие: runtime Wails слушает drop на documentElement (Windows).
 */
import { componentsTexts } from '@shared/texts/components';
import { useEffect, useId, useRef, useState, type DragEvent, type ReactElement } from 'react';
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

/** Сколько ждать нативных путей после DOM drop без файлов, прежде чем объяснить, что нужен файл с диска. */
const NATIVE_DROP_GRACE_MS = 600;

export function FileDropZone({ label, kind, multiple = false, hint, message, onFiles, onPick }: Props): ReactElement {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const id = useId();
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
  const fromDisk = image ? componentsTexts.fileDrop.image.fromDisk : audio ? componentsTexts.fileDrop.audio.fromDisk : componentsTexts.fileDrop.text.fromDisk;
  // Обработчик нативных путей читает свежие props через ref: подписка на Go живёт весь срок монтирования.
  const pendingWarning = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accept = useRef<(paths: string[]) => Promise<void>>(async () => undefined);
  accept.current = async (paths: string[]): Promise<void> => {
    if (!paths.length) {
      notify(fromDisk, 'warning');
      return;
    }
    if (paths.some((path) => !path)) {
      notify(componentsTexts.fileDrop.noNativePath, 'warning');
      return;
    }
    if ((!multiple || audio) && paths.length !== 1) {
      notify(image ? componentsTexts.fileDrop.image.single : audio ? componentsTexts.fileDrop.audio.single : componentsTexts.fileDrop.text.single, 'warning');
      return;
    }
    const extensions = (image ? IMAGE_FILTER : audio ? AUDIO_FILTER : TEXT_FILTER)[0].extensions;
    const extension = (path: string): string => {
      const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
      return name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';
    };
    if (paths.some((path) => !extensions.includes(extension(path)))) {
      notify(
        image ? componentsTexts.fileDrop.image.allowed : audio ? componentsTexts.fileDrop.audio.allowed : componentsTexts.fileDrop.text.allowed,
        'warning'
      );
      return;
    }
    try {
      await onFiles([...new Set(paths)]);
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };
  useEffect(() => {
    const unsubscribe = window.api.shell.onFilesDropped((drop) => {
      if (drop.targetId !== id) return;
      if (pendingWarning.current) clearTimeout(pendingWarning.current);
      pendingWarning.current = null;
      void accept.current(drop.paths);
    });
    return () => {
      unsubscribe();
      if (pendingWarning.current) clearTimeout(pendingWarning.current);
    };
  }, [id]);
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    depth.current = 0;
    setActive(false);
    // Без файлов runtime Wails пути не запрашивает: если и Go ничего не прислал, перетащено не с диска.
    if (!event.dataTransfer.files.length) {
      if (pendingWarning.current) clearTimeout(pendingWarning.current);
      pendingWarning.current = setTimeout(() => {
        pendingWarning.current = null;
        notify(fromDisk, 'warning');
      }, NATIVE_DROP_GRACE_MS);
    }
  };
  return (
    <Box
      id={id}
      data-file-drop-target
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
