import { schemesTexts } from '@shared/texts/schemes';
import { Fragment, useState, type ReactElement } from 'react';
import { ListSubheader, Menu, MenuItem, Stack } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import type { SchemePoint } from '@shared/schemes';
import { buildRoom, DEFAULT_ROOM, ROOM_LIMITS, SCHEME_PRESET_GROUPS, SCHEME_PRESETS, type RoomSize, type SchemePresetObject } from '@shared/scheme-presets';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { NumberField } from '../../../components/NumberField';

/** Заготовка к добавлению: объекты вокруг точки и название каждого по коду части. */
export interface PresetAddition {
  objects: SchemePresetObject[];
  name(part: string | undefined): string;
}

/**
 * Кнопка «Добавить из набора»: меню заготовок по группам и окно ввода размеров «Комнаты». Сама схему не меняет:
 * готовые объекты вокруг центра at отдаёт в onAdd, а редактор вносит их в схему одной правкой.
 */
export function SchemePresetMenu({ at, onAdd }: { at: SchemePoint; onAdd(addition: PresetAddition): void }): ReactElement {
  const texts = schemesTexts.presets;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [room, setRoom] = useState<RoomSize>(DEFAULT_ROOM);
  const roomValid =
    room.width >= ROOM_LIMITS.min &&
    room.length >= ROOM_LIMITS.min &&
    room.height >= ROOM_LIMITS.minHeight &&
    room.width <= ROOM_LIMITS.max &&
    room.length <= ROOM_LIMITS.max &&
    room.height <= ROOM_LIMITS.maxHeight;
  const close = (): void => setAnchor(null);

  return (
    <>
      <ActionButton startIcon={<AddIcon />} title={texts.hint} onClick={(event) => setAnchor(event.currentTarget)}>
        {texts.add}
      </ActionButton>
      <Menu anchorEl={anchor} open={!!anchor} onClose={close} slotProps={{ list: { dense: true } }}>
        {SCHEME_PRESET_GROUPS.map((group) => (
          <Fragment key={group}>
            <ListSubheader sx={{ lineHeight: '32px' }}>{texts.groups[group]}</ListSubheader>
            {SCHEME_PRESETS.filter((preset) => preset.group === group).map((preset) => (
              <MenuItem
                key={preset.id}
                data-preset={preset.id}
                onClick={() => {
                  close();
                  onAdd({
                    objects: preset.build(at),
                    name: (part) =>
                      part
                        ? (texts.parts[preset.id]?.[part] ?? texts.names[preset.id as keyof typeof texts.names])
                        : texts.names[preset.id as keyof typeof texts.names]
                  });
                }}
              >
                {texts.names[preset.id as keyof typeof texts.names]}
              </MenuItem>
            ))}
            {group === 'interior' ? (
              <MenuItem
                data-preset="room"
                onClick={() => {
                  close();
                  setRoomOpen(true);
                }}
              >
                {texts.room.menu}
              </MenuItem>
            ) : null}
          </Fragment>
        ))}
      </Menu>
      <ConfirmationDialog
        open={roomOpen}
        title={texts.room.title}
        description={texts.room.hint}
        confirmLabel={texts.room.confirm}
        confirmIcon={<AddIcon />}
        confirmDisabled={!roomValid}
        confirmDisabledReason={texts.room.hint}
        onClose={() => setRoomOpen(false)}
        onConfirm={() => {
          setRoomOpen(false);
          onAdd({ objects: buildRoom(at, room), name: (part) => texts.parts.room[part ?? 'floor'] });
        }}
      >
        <Stack spacing={2} sx={{ pt: 1 }}>
          <NumberField
            label={texts.room.width}
            value={room.width}
            min={ROOM_LIMITS.min}
            max={ROOM_LIMITS.max}
            step={0.5}
            onChange={(value) => value !== undefined && setRoom({ ...room, width: value })}
          />
          <NumberField
            label={texts.room.length}
            value={room.length}
            min={ROOM_LIMITS.min}
            max={ROOM_LIMITS.max}
            step={0.5}
            onChange={(value) => value !== undefined && setRoom({ ...room, length: value })}
          />
          <NumberField
            label={texts.room.height}
            value={room.height}
            min={ROOM_LIMITS.minHeight}
            max={ROOM_LIMITS.maxHeight}
            step={0.1}
            onChange={(value) => value !== undefined && setRoom({ ...room, height: value })}
          />
        </Stack>
      </ConfirmationDialog>
    </>
  );
}
