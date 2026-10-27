import type { ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HomeRedirect, Layout, RequireProject, RequireScenario } from './components';
import {
  AnimaticPage,
  CastPage,
  ChecksPage,
  EnvironmentPage,
  HelpPage,
  JobsPage,
  NewProjectPage,
  MontagePage,
  ProjectPage,
  ProductionPage,
  ProjectsPage,
  ScenarioPage,
  ScenesPage,
  SettingsPage,
  SourcesPage,
  TimingPage
} from './pages';
import { AppProvider } from './state';
import { ThemeModeProvider } from './theme';
import { MontagePlayerPage } from './pages/MontagePlayerPage';

export function App(): ReactElement {
  return (
    <ThemeModeProvider>
      <HashRouter>
        <Routes>
          <Route path="montage-player" element={<MontagePlayerPage />} />
          <Route
            element={
              <AppProvider>
                <Layout />
              </AppProvider>
            }
          >
            <Route index element={<HomeRedirect />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/new" element={<NewProjectPage />} />
            <Route
              path="project"
              element={
                <RequireProject>
                  <ProjectPage />
                </RequireProject>
              }
            />
            <Route
              path="project/sources"
              element={
                <RequireProject>
                  <SourcesPage />
                </RequireProject>
              }
            />
            <Route
              path="project/timing"
              element={
                <RequireProject>
                  <TimingPage />
                </RequireProject>
              }
            />
            <Route
              path="project/cast"
              element={
                <RequireProject>
                  <CastPage />
                </RequireProject>
              }
            />
            <Route
              path="project/scenario"
              element={
                <RequireProject>
                  <ScenarioPage />
                </RequireProject>
              }
            />
            <Route
              path="project/production"
              element={
                <RequireProject>
                  <RequireScenario title="Производство">
                    <ProductionPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/scenes"
              element={
                <RequireProject>
                  <RequireScenario title="Сцены">
                    <ScenesPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/montage"
              element={
                <RequireProject>
                  <RequireScenario title="Монтаж пробы">
                    <MontagePage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/checks"
              element={
                <RequireProject>
                  <RequireScenario title="Проверки">
                    <ChecksPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/animatic"
              element={
                <RequireProject>
                  <RequireScenario title="Аниматик">
                    <AnimaticPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route path="environment" element={<EnvironmentPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="help" element={<HelpPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </ThemeModeProvider>
  );
}
