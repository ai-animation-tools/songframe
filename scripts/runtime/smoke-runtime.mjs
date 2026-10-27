/** Проверка перемещённого runtime с кириллицей и без Python в PATH. @link README.md */
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const target = `${process.platform}-${process.arch}`;
const work = await mkdtemp(join(tmpdir(), 'songframe-runtime-'));
try {
  const root = join(work, 'Перенесённое приложение с пробелами');
  await cp(join(repo, 'build/runtime', target), join(root, 'runtime'), { recursive: true });
  await cp(join(repo, 'tools'), join(root, 'tools'), {
    recursive: true,
    filter: (path) => !path.includes('__pycache__') && !path.includes('testdata') && !path.includes('test_')
  });
  const project = join(work, 'Проект с пробелами');
  await cp(join(repo, 'tools/testdata/sample-project'), project, { recursive: true });
  const env = { ...process.env, PATH: '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  const python = join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  for (const args of [
    ['-I', '-B', '-X', 'utf8', join(here, 'runtime-probe.py'), '--empty-path'],
    ['-B', '-X', 'utf8', join(root, 'tools/check_workspace/check_workspace.py'), '--project', project, '--json']
  ]) {
    const result = spawnSync(python, args, { cwd: work, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || `Код ${result.status}`);
    console.log(result.stdout.trim());
  }
  const manifest = JSON.parse(await readFile(join(root, 'runtime/manifest.json'), 'utf8'));
  console.log(`Переносимый runtime ${manifest.target}: OK`);
} finally {
  await rm(work, { recursive: true, force: true });
}
