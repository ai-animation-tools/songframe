/** Инструкции принадлежат переносимым данным проекта; редактор и запуск читают один контракт. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { copyTemplate } from './template';
import { readProjectAgentInstructions, readProjectSettings, writeProjectSettings } from './checks';

let work: string;
let project: string;
const base = { schema_version: 1, name: 'Клип', animatic_video: 'clip.mp4', generation: null };
const instructions = '  Первая строка\r\n\n«Вторая»\t$(не исполнять)  \n';
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-instructions-'));
  project = join(work, 'Клип');
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify(base));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

it('отсутствующее поле читается пустым без записи в проект', () => {
  const raw = readFileSync(join(project, 'plan/project.json'), 'utf8');
  expect(readProjectSettings(project).agentInstructions).toBe('');
  expect(readProjectAgentInstructions(project)).toBe('');
  expect(readFileSync(join(project, 'plan/project.json'), 'utf8')).toBe(raw);
});

it('сохраняет дословный текст, повторно читает и переносит его вместе с проектом', () => {
  const saved = writeProjectSettings(project, { ...readProjectSettings(project), agentInstructions: instructions });
  expect(saved.agentInstructions).toBe(instructions);
  expect(JSON.parse(readFileSync(join(project, 'plan/project.json'), 'utf8')).agent_instructions).toBe(instructions);
  const moved = join(work, 'Перенесённый клип');
  cpSync(project, moved, { recursive: true });
  rmSync(project, { recursive: true });
  expect(readProjectSettings(moved).agentInstructions).toBe(instructions);
  expect(readProjectAgentInstructions(moved)).toBe(instructions);
});

it('сохранение других настроек не удаляет поле, а явная пустая строка очищает инструкции', () => {
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ ...base, agent_instructions: instructions, extension: 42 }));
  const { agentInstructions, ...settings } = readProjectSettings(project);
  expect(agentInstructions).toBe(instructions);
  expect(writeProjectSettings(project, settings).agentInstructions).toBe(instructions);
  expect(writeProjectSettings(project, { ...settings, agentInstructions: '' }).agentInstructions).toBe('');
  expect(JSON.parse(readFileSync(join(project, 'plan/project.json'), 'utf8')).extension).toBe(42);
});

it.each([null, 42, false, [], {}])('повреждённое поле %j не скрывается при чтении и не записывается', (value) => {
  const path = join(project, 'plan/project.json');
  writeFileSync(path, JSON.stringify({ ...base, agent_instructions: value }));
  expect(() => readProjectSettings(project)).toThrow('plan/project.json: agent_instructions должен быть строкой.');
  expect(() => readProjectAgentInstructions(project)).toThrow('agent_instructions должен быть строкой.');
  const raw = readFileSync(path, 'utf8');
  expect(() =>
    writeProjectSettings(project, { name: base.name, animaticVideo: base.animatic_video, generation: null, agentInstructions: value as string })
  ).toThrow('agent_instructions должен быть строкой.');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(() => writeProjectSettings(project, { name: 'Другое имя', animaticVideo: base.animatic_video, generation: null })).toThrow(
    'agent_instructions должен быть строкой.'
  );
  expect(readFileSync(path, 'utf8')).toBe(raw);
});

it('созданный из шаблона проект повторно открывается с пустыми инструкциями', () => {
  const created = join(work, 'Новый клип');
  copyTemplate('templates/project', created, { project_name: 'Новый клип', animatic_video: 'new.mp4' });
  expect(readProjectSettings(created)).toMatchObject({ name: 'Новый клип', animaticVideo: 'new.mp4', agentInstructions: '' });
  expect(readProjectAgentInstructions(created)).toBe('');
});
