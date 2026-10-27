/** Настоящие fake CLI и Python проверяют оба прохода без провайдеров и изменения исходных материалов. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSettings } from '@shared/agents';
import type { CastFile, ScenesFile, TreatmentFile } from '@shared/types';
import { AgentManager } from './agent-manager';
import { PythonLauncher } from './python-launcher';
import { SettingsStore } from './settings';
import { publishScenario } from './scenario-apply';
import { ScenarioWorkflow } from './scenario-workflow';

const REPO = resolve(__dirname, '../..');
const workspaces: string[] = [];
const managers: AgentManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const work of workspaces.splice(0)) rmSync(work, { recursive: true, force: true });
});

function hashes(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, hashes(root, path));
    else if (entry.isFile())
      result[path] = createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
  }
  return result;
}

it.each<AgentSettings['provider']>(['claude', 'codex'])(
  '%s: два прохода, применение и доработка через настоящий Python',
  async (provider) => {
    const work = mkdtempSync(join(tmpdir(), 'songframe-сценарий-'));
    workspaces.push(work);
    const project = join(work, 'Клип с пробелами');
    cpSync(join(REPO, 'tools/testdata/sample-project'), project, { recursive: true });
    const read = <T>(path: string): T => JSON.parse(readFileSync(join(project, path), 'utf8')) as T;
    const cast = read<CastFile>('plan/cast.json');
    const treatment = read<TreatmentFile>('plan/treatment.json');
    treatment.logline = 'Друзья вместе преодолевают трудную лесную дорогу.';
    rmSync(join(project, 'plan/treatment.json'));
    rmSync(join(project, 'plan/scenes.json'));
    const protectedFiles = { ...hashes(project, 'source'), ...hashes(project, 'assets') };
    const localDir = join(work, 'state');
    const settings = new SettingsStore(localDir);
    const mode = join(work, 'mode');
    const capture = join(work, 'capture.json');
    const executablePath = join(work, `${provider}-fake`);
    writeFileSync(mode, 'normal');
    // Процесс только возвращает ответ: инструменты проверки и запись принадлежат приложению.
    writeFileSync(
      executablePath,
      `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2), provider=${JSON.stringify(provider)};
if(args[0]==='--version'){console.log(provider==='claude'?'2.1.284 (Claude Code)':'codex-cli 0.159.2');process.exit(0);}
if(args[0]==='auth'||args[0]==='login'){if(provider==='claude')console.log('{"loggedIn":true}');else console.error('Logged in using ChatGPT');process.exit(0);}
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,cwd:process.cwd(),input}));
 const context=JSON.parse(input.split('\\n\\nДополнительный контекст:\\n').pop());
 let proposal;
 if(context.pass==='treatment')proposal={schemaVersion:1,pass:'treatment',cast:${JSON.stringify(cast)},treatment:${JSON.stringify(treatment)}};
 else if(context.pass==='scenes'){
  const scenes=context.scenes;scenes.visual_direction='Лесная дорога, естественный свет и последовательное движение героев.';
  for(const shot of scenes.scenes){shot.camera='Средний план, плавный проезд';shot.action='Герои движутся вдоль реки.';shot.continuity='Направление движения и одежда сохраняются.';}
  proposal={schemaVersion:1,pass:'scenes',scenes};
 }else proposal={schemaVersion:1,pass:'revise',patches:[{id:context.selectedIds[0],action:'Мира поправляет рукав куртки.'}]};
 const text=fs.readFileSync(${JSON.stringify(mode)},'utf8')==='malformed'?'{broken':JSON.stringify(proposal);
 if(provider==='claude'){
  send({type:'system',subtype:'init',session_id:'scenario-test'});
  send({type:'stream_event',event:{delta:{type:'text_delta',text}}});
  setTimeout(()=>send({type:'result',subtype:'success',is_error:false,result:text}),30);
 }else{
  send({type:'thread.started',thread_id:'scenario-test'});send({type:'turn.started'});
  send({type:'item.completed',item:{id:'answer',type:'agent_message',text}});setTimeout(()=>send({type:'turn.completed'}),30);
 }
});
`,
      { mode: 0o700 }
    );
    settings.saveAgent({ provider, executablePath });
    const manager = new AgentManager(settings);
    managers.push(manager);
    const launcher = new PythonLauncher({ toolsRoot: REPO, localDir });
    const workflow = new ScenarioWorkflow({
      agents: manager,
      localDir,
      toolsRoot: () => REPO,
      scaffold: async (path) => {
        const result = await launcher.run(path, 'scene_scaffold', ['--dry-run', '--json']);
        expect(result.code, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as ScenesFile;
      },
      publish: (input) => publishScenario(input, { localDir, launcher })
    });
    const ready = async (): Promise<void> => {
      await vi.waitFor(() => expect(workflow.view(project).proposal?.status).not.toBe('running'), { timeout: 15000, interval: 30 });
      const value = workflow.view(project);
      expect(value.proposal?.status, value.proposal?.message).toBe('ready');
    };
    expect(workflow.view(project).canStartScenes).toBe(false);
    await workflow.start({ project, pass: 'treatment' });
    await ready();
    expect(existsSync(join(project, 'plan/treatment.json'))).toBe(false);
    expect((await workflow.apply(project, workflow.view(project).proposal!.id)).treatmentApproved).toBe(true);
    await workflow.start({ project, pass: 'scenes' });
    await ready();
    expect(existsSync(join(project, 'plan/scenes.json'))).toBe(false);
    await workflow.apply(project, workflow.view(project).proposal!.id);
    const saved = read<ScenesFile>('plan/scenes.json');
    expect(saved.scenes.length).toBeGreaterThan(1);
    expect(existsSync(join(project, 'plan/animatic/cards/manifest.json'))).toBe(true);
    expect((await launcher.run(project, 'update_scene_views', ['--check'])).code).toBe(0);
    const selectedId = saved.scenes[0].id;
    await workflow.start({ project, pass: 'revise', selectedIds: [selectedId], note: 'Добавить жест с рукавом.' });
    await ready();
    await workflow.apply(project, workflow.view(project).proposal!.id);
    const revised = read<ScenesFile>('plan/scenes.json');
    expect(revised.scenes[0].action).toBe('Мира поправляет рукав куртки.');
    expect(revised.scenes.slice(1)).toEqual(saved.scenes.slice(1));
    const beforeFailure = readFileSync(join(project, 'plan/scenes.json'), 'utf8');
    writeFileSync(mode, 'malformed');
    await workflow.start({ project, pass: 'treatment' });
    await vi.waitFor(() => expect(workflow.view(project).proposal?.status).toBe('invalid'), { timeout: 15000 });
    await expect(workflow.apply(project, workflow.view(project).proposal!.id)).rejects.toThrow();
    expect(readFileSync(join(project, 'plan/scenes.json'), 'utf8')).toBe(beforeFailure);
    for (const [path, hash] of Object.entries(protectedFiles)) {
      if (path === 'assets/shots/manifest.json' || /^assets\/shots\/M[^/]+\/README.md$/.test(path)) continue;
      expect(
        createHash('sha256')
          .update(readFileSync(join(project, path)))
          .digest('hex'),
        path
      ).toBe(hash);
    }
    const invocation = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; cwd: string; input: string };
    expect(invocation.cwd).toBe(project);
    expect(invocation.input).toContain('output=proposal');
    expect(invocation.args).toContain(provider === 'claude' ? 'Read,Glob,Grep' : 'read-only');
    expect(workflow.view(project).treatmentApproved).toBe(true);
  },
  60000
);
