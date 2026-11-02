import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { scenarioSchema, type Scenario } from '../shared/scenario.js';
import type { RunRecord } from './runner.js';

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_');

/** Plain files on one PVC: a single controller replica and few writes need no database. */
export class Store {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly dataDir: string,
    private readonly builtinDir: string,
  ) {}

  async init(): Promise<void> {
    await mkdir(join(this.dataDir, 'runs'), { recursive: true });
    await mkdir(join(this.dataDir, 'scenarios'), { recursive: true });
  }

  /** Writes of one file run one after the other: a run saves itself from several places. */
  private writeJson(path: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value, null, 2);
    const write = async () => {
      await writeFile(`${path}.tmp`, json);
      await rename(`${path}.tmp`, path);
    };
    const queued = (this.writes.get(path) ?? Promise.resolve()).then(write, write);
    this.writes.set(path, queued);
    return queued;
  }

  saveRun(run: RunRecord): Promise<void> {
    return this.writeJson(join(this.dataDir, 'runs', `${run.id}.json`), run);
  }

  async listRuns(): Promise<RunRecord[]> {
    const dir = join(this.dataDir, 'runs');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const runs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as RunRecord));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listScenarios(): Promise<{ scenario: Scenario; builtin: boolean }[]> {
    const result: { scenario: Scenario; builtin: boolean }[] = [];
    const builtin = await readdir(this.builtinDir).catch(() => [] as string[]);
    for (const f of builtin.filter((name) => name.endsWith('.yaml'))) {
      const scenario = scenarioSchema.parse(parse(await readFile(join(this.builtinDir, f), 'utf8')));
      result.push({ scenario, builtin: true });
    }
    const dir = join(this.dataDir, 'scenarios');
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const scenario = scenarioSchema.parse(JSON.parse(await readFile(join(dir, f), 'utf8')));
      result.push({ scenario, builtin: false });
    }
    return result;
  }

  saveScenario(s: Scenario): Promise<void> {
    return this.writeJson(join(this.dataDir, 'scenarios', `${safeName(s.name)}.json`), s);
  }

  deleteScenario(name: string): Promise<void> {
    return rm(join(this.dataDir, 'scenarios', `${safeName(name)}.json`), { force: true });
  }
}
