/** Оболочка: шапка с проектом и темой, боковая навигация по этапам, область страницы. */

import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { AppBar, Box, Button, Chip, Divider, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, Tooltip, Typography } from '@mui/material';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import BuildIcon from '@mui/icons-material/Build';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import GridViewIcon from '@mui/icons-material/GridView';
import GroupsIcon from '@mui/icons-material/Groups';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import HistoryIcon from '@mui/icons-material/History';
import LibraryMusicIcon from '@mui/icons-material/LibraryMusic';
import LightModeIcon from '@mui/icons-material/LightMode';
import MovieIcon from '@mui/icons-material/Movie';
import SettingsSuggestIcon from '@mui/icons-material/SettingsSuggest';
import SettingsIcon from '@mui/icons-material/Settings';
import TheatersIcon from '@mui/icons-material/Theaters';
import TimelineIcon from '@mui/icons-material/Timeline';
import { type ReactElement, useEffect, useRef } from 'react';
import { useApp } from '../state';
import { useThemeMode } from '../theme';
import { StateChip } from './StateChip';

const WIDTH = 236;

interface NavItem {
  to: string;
  label: string;
  icon: ReactElement;
  needsProject?: boolean;
  stage?: number;
}

const ITEMS: NavItem[] = [
  { to: '/projects', label: 'Проекты', icon: <FolderOpenIcon /> },
  { to: '/project', label: 'Проект', icon: <LibraryMusicIcon />, needsProject: true },
  { to: '/project/sources', label: 'Исходники', icon: <AudiotrackIcon />, needsProject: true },
  { to: '/project/timing', label: 'Тайминги', icon: <TimelineIcon />, needsProject: true },
  { to: '/project/cast', label: 'Кастинг', icon: <GroupsIcon />, needsProject: true },
  { to: '/project/scenario', label: 'Сценарий', icon: <TheatersIcon />, needsProject: true },
  { to: '/project/production', label: 'Производство', icon: <BuildIcon />, needsProject: true },
  { to: '/project/scenes', label: 'Сцены', icon: <GridViewIcon />, needsProject: true },
  { to: '/project/montage', label: 'Монтаж пробы', icon: <MovieIcon />, needsProject: true },
  { to: '/project/checks', label: 'Проверки', icon: <FactCheckIcon />, needsProject: true },
  { to: '/project/animatic', label: 'Аниматик', icon: <MovieIcon />, needsProject: true },
  { to: '/jobs', label: 'Журнал заданий', icon: <HistoryIcon /> },
  { to: '/environment', label: 'Среда', icon: <SettingsSuggestIcon /> },
  { to: '/settings', label: 'Настройки', icon: <SettingsIcon /> },
  { to: '/help', label: 'Справка', icon: <HelpOutlineIcon /> }
];

export function Layout(): ReactElement {
  const { state, status, openProject, notify, describeError } = useApp();
  const { resolved, setMode } = useThemeMode();
  const navigate = useNavigate();
  const notificationQueue = useRef<Promise<void>>(Promise.resolve());
  const hasProject = !!state?.current;

  useEffect(() => {
    return window.api.notifications.onOpen((target) => {
      // Открываем проекты последовательно: поздний ответ старого клика не вернёт предыдущий проект.
      // Очередь сохраняется между переподписками при навигации, а ошибка не блокирует следующие клики.
      notificationQueue.current = notificationQueue.current
        .then(async () => {
          await openProject(target.project);
          navigate(target.route);
        })
        .catch((error) => notify(describeError(error), 'error'));
    });
  }, [openProject, navigate, notify, describeError]);

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" color="default" elevation={0} sx={{ zIndex: (t) => t.zIndex.drawer + 1, borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} sx={{ cursor: 'pointer' }} onClick={() => navigate('/')}>
            SongFrame
          </Typography>
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
            {status ? (
              <>
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {status.name}
                </Typography>
                <StateChip state={status.state} size="small" />
                {/* Путь остаётся виден при наведении, даже если длинное имя сокращено в шапке. */}
                <Button
                  size="small"
                  color="inherit"
                  startIcon={<FolderOpenIcon fontSize="small" />}
                  title={`Открыть папку проекта: ${status.path}`}
                  aria-label={`Открыть папку проекта: ${status.path}`}
                  onClick={() =>
                    window.api.shell.openPath(status.path).catch((error) => notify(`Не удалось открыть папку проекта: ${describeError(error)}`, 'error'))
                  }
                  sx={{ minWidth: 0, maxWidth: '100%', color: 'text.secondary', textTransform: 'none' }}
                >
                  <Typography variant="caption" noWrap>
                    {status.path}
                  </Typography>
                </Button>
              </>
            ) : (
              <Chip size="small" variant="outlined" label="Проект не выбран" />
            )}
          </Box>
          <Tooltip title={resolved === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
            <Button
              size="small"
              startIcon={resolved === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
              onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
            >
              {resolved === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            </Button>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" sx={{ width: WIDTH, flexShrink: 0, '& .MuiDrawer-paper': { width: WIDTH, boxSizing: 'border-box' } }}>
        <Toolbar variant="dense" />
        <List dense sx={{ pt: 1 }}>
          {ITEMS.map((item, index) => {
            const disabled = (item.needsProject && !hasProject) || item.stage !== undefined;
            const button = (
              <ListItemButton
                key={item.to}
                component={NavLink}
                to={item.to}
                end={item.to === '/project'}
                disabled={disabled}
                sx={{ '&.active': { bgcolor: 'action.selected', '& .MuiListItemIcon-root': { color: 'primary.main' } } }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} secondary={item.stage ? `этап ${item.stage}` : undefined} />
              </ListItemButton>
            );
            return (
              <Box key={item.to}>
                {index === 1 || item.to === '/settings' ? <Divider sx={{ my: 1 }} /> : null}
                {item.stage ? (
                  <Tooltip title={`Появится на этапе ${item.stage}`} placement="right">
                    <span>{button}</span>
                  </Tooltip>
                ) : (
                  button
                )}
              </Box>
            );
          })}
        </List>
      </Drawer>
      {/* Страницы перестраивают блоки по доступной ширине рабочей области, уже без бокового меню. */}
      <Box component="main" sx={{ flex: 1, minWidth: 0, p: 3, containerType: 'inline-size', containerName: 'workspace' }}>
        <Toolbar variant="dense" />
        <Outlet />
      </Box>
    </Box>
  );
}
