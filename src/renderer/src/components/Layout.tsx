/** Оболочка: шапка с проектом и темой, боковая навигация по этапам, область страницы. */

import { commonTexts } from '@shared/texts/common';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PageLoaderArea } from './PageLoader';
import {
  AppBar,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  GlobalStyles,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Tooltip,
  Typography
} from '@mui/material';
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
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useApp } from '../state';
import { useThemeMode } from '../theme';
import { StateChip } from './StateChip';
import { NetworkErrorMessage } from './NetworkErrorMessage';
import { BASE_HEADER_HEIGHT, HeaderHeightContext } from './headerHeight';
import { NAV_PAGES, type NavPage } from '../navigation';
import { anchorHighlightStyles, useAnchorTarget } from '../hooks/useAnchorTarget';

const WIDTH = 236;

interface NavItem extends NavPage {
  icon: ReactElement;
  stage?: number;
}

// Подписи и маршруты — в общей таблице навигации: по ней же тексты сообщений превращают «Страницу» в ссылку.
const ICONS: Record<string, ReactElement> = {
  '/projects': <FolderOpenIcon />,
  '/project': <LibraryMusicIcon />,
  '/project/sources': <AudiotrackIcon />,
  '/project/timing': <TimelineIcon />,
  '/project/cast': <GroupsIcon />,
  '/project/scenario': <TheatersIcon />,
  '/project/production': <BuildIcon />,
  '/project/scenes': <GridViewIcon />,
  '/project/montage': <MovieIcon />,
  '/project/checks': <FactCheckIcon />,
  '/project/animatic': <MovieIcon />,
  '/jobs': <HistoryIcon />,
  '/environment': <SettingsSuggestIcon />,
  '/settings': <SettingsIcon />,
  '/help': <HelpOutlineIcon />
};

const ITEMS: NavItem[] = NAV_PAGES.map((page) => ({ ...page, icon: ICONS[page.to] }));

export function Layout(): ReactElement {
  const { state, status, openProject, refreshStatus, notify, describeError } = useApp();
  const { resolved, setMode } = useThemeMode();
  const navigate = useNavigate();
  const location = useLocation();
  const notificationQueue = useRef<Promise<void>>(Promise.resolve());
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(BASE_HEADER_HEIGHT);
  // Высота шапки меняется вместе с сообщением о сети; панели страниц закрепляются под её фактическим краем.
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(() => setHeaderHeight(Math.round(header.getBoundingClientRect().height)));
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const hasProject = !!state?.current;
  // Страницы меняют файлы проекта (аниматик, сцены, сценарий): при переходе статус в шапке пересчитывается из файлов.
  useEffect(() => {
    void refreshStatus();
  }, [location.pathname, refreshStatus]);
  // Ссылки из текстов (LinkedText) ведут с ?anchor=: прокрутка к цели работает на любой странице оболочки.
  useAnchorTarget();

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
      <GlobalStyles styles={anchorHighlightStyles} />
      <AppBar
        ref={headerRef}
        position="fixed"
        color="default"
        elevation={0}
        sx={{ zIndex: (t) => t.zIndex.drawer + 1, borderBottom: 1, borderColor: 'divider' }}
      >
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
                  title={commonTexts.shell.openProjectFolder({ path: status.path })}
                  aria-label={commonTexts.shell.openProjectFolder({ path: status.path })}
                  onClick={() =>
                    window.api.shell
                      .openPath(status.path)
                      .catch((error) => notify(commonTexts.shell.openProjectFolderFailed({ reason: describeError(error) }), 'error'))
                  }
                  sx={{ minWidth: 0, maxWidth: '100%', color: 'text.secondary', textTransform: 'none' }}
                >
                  <Typography variant="caption" noWrap>
                    {status.path}
                  </Typography>
                </Button>
              </>
            ) : (
              <Chip size="small" variant="outlined" label={commonTexts.shell.noProject} />
            )}
          </Box>
          <Tooltip title={resolved === 'dark' ? commonTexts.shell.lightTheme : commonTexts.shell.darkTheme}>
            <Button
              size="small"
              startIcon={resolved === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
              onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
            >
              {resolved === 'dark' ? commonTexts.shell.lightTheme : commonTexts.shell.darkTheme}
            </Button>
          </Tooltip>
        </Toolbar>
        {/* Сообщение о сети входит в закреплённую шапку: оно видно при любой прокрутке, а панели страниц встают под ним. */}
        <NetworkErrorMessage />
      </AppBar>
      <Drawer variant="permanent" sx={{ width: WIDTH, flexShrink: 0, '& .MuiDrawer-paper': { width: WIDTH, boxSizing: 'border-box' } }}>
        {/* Меню начинается под шапкой и сдвигается вместе с ней, когда показано сообщение о сети. */}
        <Box sx={{ height: headerHeight - 1, flexShrink: 0 }} />
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
                <ListItemText primary={item.label} secondary={item.stage ? commonTexts.shell.stage({ stage: item.stage }) : undefined} />
              </ListItemButton>
            );
            return (
              <Box key={item.to}>
                {index === 1 || item.to === '/settings' ? <Divider sx={{ my: 1 }} /> : null}
                {/* Недоступный пункт меню объясняет причину при наведении. */}
                {disabled ? (
                  <Tooltip title={item.stage ? commonTexts.shell.availableAtStage({ stage: item.stage }) : commonTexts.shell.selectProject} placement="right">
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
        {/* Отступ равен шапке без нижней границы, как прежняя плотная панель. */}
        <Box sx={{ height: headerHeight - 1 }} />
        <HeaderHeightContext.Provider value={headerHeight}>
          {/* Пока страница загружает данные, поверх неё виден общий индикатор (страница сообщает через usePageLoading). */}
          <PageLoaderArea key={location.pathname}>
            <Outlet />
          </PageLoaderArea>
        </HeaderHeightContext.Provider>
      </Box>
    </Box>
  );
}
