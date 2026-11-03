import { AppBar, Box, Button, Chip, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, Tooltip } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import BuildIcon from '@mui/icons-material/Build';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import FactCheckIcon from '@mui/icons-material/FactCheck';
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
import { type ReactElement, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { commonTexts } from '@shared/texts/common';
import { shellTexts } from '@shared/texts/shell';
import { NAV_PAGES } from '../navigation';
import { useThemeMode } from '../theme';

const WIDTH = 236;
const HEADER_HEIGHT = 48;
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

/** Сохраняет компоновку SongFrame: общую шапку, меню 236 px и самостоятельную рабочую область.
 * Не запускает доменные API при навигации: до переноса соответствующего сервиса действия объяснимо недоступны.
 */
export function ShellLayout({ children }: { children: ReactNode }) {
  const { resolved, setMode } = useThemeMode();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" color="default" elevation={0} sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Button color="inherit" onClick={() => navigate('/projects')} sx={{ fontWeight: 700, textTransform: 'none' }}>
            {shellTexts.title}
          </Button>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Chip size="small" variant="outlined" label={shellTexts.noProject} />
          </Box>
          <Button
            size="small"
            startIcon={resolved === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
            onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
          >
            {resolved === 'dark' ? commonTexts.shell.lightTheme : commonTexts.shell.darkTheme}
          </Button>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" sx={{ width: WIDTH, flexShrink: 0, '& .MuiDrawer-paper': { width: WIDTH, boxSizing: 'border-box' } }}>
        <Box sx={{ height: HEADER_HEIGHT, flexShrink: 0 }} />
        <List dense aria-label={shellTexts.navigation} sx={{ pt: 1 }}>
          {NAV_PAGES.map((item) =>
            item.to === '/projects' ? (
              <ListItemButton key={item.to} component={NavLink} to={item.to} selected={location.pathname === item.to || location.pathname === '/'}>
                <ListItemIcon sx={{ minWidth: 34 }}>{ICONS[item.to]}</ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            ) : (
              <Tooltip key={item.to} title={shellTexts.unavailable} placement="right">
                <Box tabIndex={0} role="link" aria-disabled="true" aria-label={item.label} sx={{ outlineOffset: -2 }}>
                  <ListItemButton disabled component="div" sx={{ pointerEvents: 'none' }}>
                    <ListItemIcon sx={{ minWidth: 34 }}>{ICONS[item.to]}</ListItemIcon>
                    <ListItemText primary={item.label} />
                  </ListItemButton>
                </Box>
              </Tooltip>
            )
          )}
        </List>
      </Drawer>
      <Box component="main" sx={{ flex: 1, minWidth: 0, pt: `${HEADER_HEIGHT}px`, containerType: 'inline-size', containerName: 'workspace' }}>
        <Box sx={{ p: 3 }}>{children}</Box>
      </Box>
    </Box>
  );
}
