import type { CompareCase, SimulationResult, ToastMessage, WorkspacePlan } from '../types';
import { createDefaultPlan } from '../lib/defaults';
import { idbDeleteCase, idbGetAllCases, idbGetKV, idbPutCompareCase, idbPutPlan, idbSetKV } from '../lib/db';

export type Route = 'config' | 'orbit' | 'simulate' | 'power' | 'compare' | 'settings';

interface StoreState {
  ready: boolean;
  route: Route;
  plan: WorkspacePlan;
  cases: CompareCase[];
  result: SimulationResult | null;
  running: boolean;
  runMessage: string;
  toasts: ToastMessage[];
  webgpuNote: string;
}

type Listener = (state: StoreState) => void;

class Store {
  state: StoreState = {
    ready: false,
    route: 'config',
    plan: createDefaultPlan(),
    cases: [],
    result: null,
    running: false,
    runMessage: '',
    toasts: [],
    webgpuNote: '',
  };
  private listeners = new Set<Listener>();
  private saveTimer: number | null = null;
  private toastSeq = 1;

  async init(): Promise<void> {
    try {
      const saved = await idbGetKV<WorkspacePlan>('current-workspace');
      if (saved && saved.model && saved.orbit && saved.attitude) {
        // Merge settings so newly introduced fields have defaults.
        saved.settings = { ...this.state.plan.settings, ...saved.settings };
        this.state.plan = saved;
      }
      this.state.cases = await idbGetAllCases();
    } catch (err) {
      console.warn('IndexedDB load failed', err);
      this.toast('IndexedDB 不可用，当前更改仅保留在内存中', 'error');
    }
    this.state.ready = true;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  setRoute(route: Route): void {
    this.state.route = route;
    this.emit();
  }

  set(patch: Partial<StoreState>): void {
    Object.assign(this.state, patch);
    this.emit();
  }

  /** Mutate the current plan, refresh UI, and debounce IndexedDB persistence. */
  updatePlan(mutator: (plan: WorkspacePlan) => void, options: { silent?: boolean } = {}): void {
    mutator(this.state.plan);
    this.state.plan.updatedAt = Date.now();
    if (!options.silent) this.emit();
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void idbPutPlan(this.state.plan).then(() => {
        void idbSetKV('current-workspace', this.state.plan);
      }).catch((err) => console.warn('save failed', err));
    }, 250);
  }

  async saveNow(): Promise<void> {
    this.state.plan.updatedAt = Date.now();
    await idbPutPlan(this.state.plan);
    await idbSetKV('current-workspace', this.state.plan);
  }

  async addCompareCase(item: CompareCase): Promise<void> {
    this.state.cases = [...this.state.cases, item];
    await idbPutCompareCase(item);
    this.emit();
  }

  async removeCompareCase(id: string): Promise<void> {
    await idbDeleteCase(id);
    this.state.cases = this.state.cases.filter((c) => c.id !== id);
    this.emit();
  }

  setResult(result: SimulationResult | null): void {
    this.state.result = result;
    this.emit();
  }

  setRunning(running: boolean, message = ''): void {
    this.state.running = running;
    this.state.runMessage = message;
    this.emit();
  }

  toast(text: string, kind: ToastMessage['kind'] = 'info', timeout = 3200): void {
    const id = this.toastSeq++;
    this.state.toasts = [...this.state.toasts, { id, text, kind }];
    this.emit();
    window.setTimeout(() => this.dismissToast(id), timeout);
  }

  dismissToast(id: number): void {
    this.state.toasts = this.state.toasts.filter((t) => t.id !== id);
    this.emit();
  }
}

export const store = new Store();
