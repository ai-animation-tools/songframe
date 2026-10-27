import type { ReactElement } from 'react';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { Avatar, Box, Chip, MenuItem, TextField, Typography } from '@mui/material';
import type { CastImageOption } from '../types';

interface CastEntityImagesProps {
  images: string[];
  imagePaths: Record<string, string>;
  imageOptions: CastImageOption[];
  onChange: (images: string[]) => void;
}

/** Управляет привязками изображений: первый элемент используется как основное изображение. */
export function CastEntityImages({ images, imagePaths, imageOptions, onChange }: CastEntityImagesProps): ReactElement {
  // Старые привязки вне манифеста остаются доступны и отображаются своим путём.
  const imageLabels = new Map(imageOptions.map((option) => [option.path, option.label]));
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        Изображения (первое основное для карточек)
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Нажатие на изображение меняет основное; удаление привязки требует отдельного подтверждения. */}
        {images.map((image, index) => (
          <Box key={image} sx={{ display: 'inline-flex', alignItems: 'center' }}>
            <Chip
              avatar={<Avatar src={window.api.shell.fileUrl(imagePaths[image] ?? '')} variant="rounded" />}
              label={imageLabels.get(image) ?? image}
              title={image}
              color={index === 0 ? 'primary' : 'default'}
              variant={index === 0 ? 'filled' : 'outlined'}
              onClick={() => onChange([image, ...images.filter((i) => i !== image)])}
            />
            <DestructiveButton
              icon
              label={`Убрать изображение «${imageLabels.get(image) ?? image}»`}
              description="Привязка изображения к сущности будет удалена. Исходный файл останется в проекте."
              onConfirm={() => onChange(images.filter((i) => i !== image))}
              confirmLabel="Убрать"
            >
              <DeleteOutlineIcon fontSize="small" />
            </DestructiveButton>
          </Box>
        ))}
        <TextField
          select
          size="small"
          label="Добавить из исходников"
          value=""
          onChange={(e) => e.target.value && onChange([...images, e.target.value])}
          sx={{ minWidth: 240 }}
          disabled={!imageOptions.some((option) => !images.includes(option.path))}
        >
          {imageOptions
            .filter((option) => !images.includes(option.path))
            .map((option) => (
              <MenuItem key={option.path} value={option.path} title={option.path}>
                {option.label}
              </MenuItem>
            ))}
        </TextField>
      </Box>
      {!images.length ? (
        <Typography variant="caption" color="warning.main">
          Без изображения сущность не попадает в references реестра: её нельзя указать в кадре, пока референс не нарисован и не загружен.
        </Typography>
      ) : null}
    </Box>
  );
}
