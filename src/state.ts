import type { ScenarioCase, Settings, SimResult } from './types';
import { createLargeSatelliteCase, createSmallSatelliteCase, defaultSettings } from './data/presets';
import { getAllCases, getSettings, putCase, saveSettings } from './lib/db';

type Listener = () => void;

class Store {
  cases: ScenarioCase[] = [];
  currentId = 'case-500kg';
  compareIds: string[] = ['case-500kg', 'case-50kg'];
  settings: Settings = defaultSettings;
  results = new Map<string, SimResult>();
  loading = true;
  private listeners = new Set<Listener>();

  async init() {
    this.settings = await getSettings();
    let cases = await getAllCases();
    if (!cases.length) {
      const a = createLargeSatelliteCase();
      const b = createSmallSatelliteCase();
      await putCase(a);
      await putCase(b);
      cases = [a, b];
    }
    this.cases = cases.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    if (!this.cases.some((c) => c.id === this.currentId)) this.currentId = this.cases[0]?.id ?? '';
    this.compareIds = this.compareIds.filter((id) => this.cases.some((c) => c.id === id));
    if (this.compareIds.length < 2 && this.cases[1]) this.compareIds = [this.cases[0].id, this.cases[1].id];
    this.loading = false;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() { this.listeners.forEach((fn) => fn()); }

  current(): ScenarioCase {
    const found = this.cases.find((c) => c.id === this.currentId);
    if (!found) throw new Error('当前工况不存在');
    return found;
  }

  async updateCase(next: ScenarioCase, opts: { silent?: boolean } = {}) {
    next.updatedAt = Date.now();
    const idx = this.cases.findIndex((c) => c.id === next.id);
    if (idx >= 0) this.cases[idx] = next;
    else this.cases.push(next);
    this.results.delete(next.id);
    await putCase(structuredClone(next));
    if (!opts.silent) this.emit();
  }

  async saveCurrent(mutator: (draft: ScenarioCase) => void) {
    const draft = structuredClone(this.current());
    mutator(draft);
    await this.updateCase(draft);
  }

  async persistSettings(next: Settings) {
    this.settings = next;
    await saveSettings(next);
    this.emit();
  }

  setResult(result: SimResult) {
    this.results.set(result.caseId, result);
  }
  getResult(id = this.currentId): SimResult | undefined {
    return this.results.get(id);
  }
}

export const store = new Store();
