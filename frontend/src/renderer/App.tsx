/**
 * Маршруты приложения. Отличия от 634fd94 (D-028):
 * - добавлен маршрут /components (менеджер компонентов этапа 41.3) и служебные /native-check и /preview
 *   (второе окно) для нативной проверки Wails (флаг --native-check);
 * - onReady подтверждает Go готовность окна после первого app.state.
 */
import { navigationTexts } from '@shared/texts/navigation';
import { lazy, Suspense, type ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HomeRedirect, Layout, RequireProject, RequireScenario } from './components';
import { StartupProgress } from './components/StartupProgress';
import { ComponentsPage } from './pages/ComponentsPage';
import {
  AnimaticPage,
  CastPage,
  ChecksPage,
  EnvironmentPage,
  HelpPage,
  JobsPage,
  NewProjectPage,
  MontagePage,
  MontagePlayerPage,
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

// Служебная страница нативной проверки грузится отдельно: обычный запуск не тянет её код.
const NativeCheckPage = lazy(() => import('./pages/NativeCheckPage').then((module) => ({ default: module.NativeCheckPage })));
const NativePreviewPage = lazy(() => import('./pages/NativePreviewPage').then((module) => ({ default: module.NativePreviewPage })));

export function App({ onReady }: { onReady?: () => Promise<void> }): ReactElement {
  return (
    <ThemeModeProvider>
      <HashRouter>
        <Routes>
          <Route
            path="native-check"
            element={
              <Suspense fallback={<StartupProgress />}>
                <NativeCheckPage />
              </Suspense>
            }
          />
          <Route
            path="preview"
            element={
              <Suspense fallback={<StartupProgress />}>
                <NativePreviewPage />
              </Suspense>
            }
          />
          <Route path="montage-player" element={<MontagePlayerPage />} />
          <Route
            element={
              <AppProvider onReady={onReady}>
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
                  <RequireScenario title={navigationTexts.pages.production}>
                    <ProductionPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/scenes"
              element={
                <RequireProject>
                  <RequireScenario title={navigationTexts.pages.scenes}>
                    <ScenesPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/montage"
              element={
                <RequireProject>
                  <RequireScenario title={navigationTexts.pages.montage}>
                    <MontagePage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/checks"
              element={
                <RequireProject>
                  <RequireScenario title={navigationTexts.pages.checks}>
                    <ChecksPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route
              path="project/animatic"
              element={
                <RequireProject>
                  <RequireScenario title={navigationTexts.pages.animatic}>
                    <AnimaticPage />
                  </RequireScenario>
                </RequireProject>
              }
            />
            <Route path="environment" element={<EnvironmentPage />} />
            <Route path="components" element={<ComponentsPage />} />
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
