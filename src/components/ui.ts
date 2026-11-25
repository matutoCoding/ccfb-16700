export function el<T extends HTMLElement = HTMLDivElement>(html: string): T {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild as T;
}

export function field(label: string, input: string, hint = ''): string {
  return `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
}

export function numInput(path: string, value: number, step = 'any', min?: number): string {
  return `<input data-bind="${path}" type="number" step="${step}" ${min !== undefined ? `min="${min}"` : ''} value="${roundInput(value)}" />`;
}

export function textInput(path: string, value: string): string {
  return `<input data-bind="${path}" type="text" value="${escapeAttr(value)}" />`;
}

export function selectInput(path: string, value: string, options: Array<[string, string]>): string {
  return `<select data-bind="${path}">${options.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
}

export function vec3Inputs(path: string, value: [number, number, number], step = '0.01'): string {
  return `<div class="vec3">${[0, 1, 2].map((i) => `<input data-bind="${path}.${i}" type="number" step="${step}" value="${roundInput(value[i])}" aria-label="${path}[${i}]" />`).join('')}</div>`;
}

export function roundInput(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.abs(x) < 1e-10 ? 0 : Number(x.toFixed(6));
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function bindRoot(root: HTMLElement, onChange: (path: string, value: string | number | boolean) => void) {
  const handler = (e: Event) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const path = target.dataset.bind;
    if (!path) return;
    if (target.type === 'checkbox') onChange(path, (target as HTMLInputElement).checked);
    else if (target.type === 'number') onChange(path, target.value === '' ? 0 : Number(target.value));
    else onChange(path, target.value);
  };
  root.addEventListener('input', handler);
  root.addEventListener('change', handler);
  return () => {
    root.removeEventListener('input', handler);
    root.removeEventListener('change', handler);
  };
}

export function setPath<T extends object>(obj: T, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = isIndex(parts[i]) ? String(Number(parts[i])) : parts[i];
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  cur[isIndex(last) ? Number(last) : last] = value;
}

function isIndex(s: string): boolean {
  return /^\d+$/.test(s);
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info') {
  let host = document.querySelector<HTMLDivElement>('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const item = el<HTMLDivElement>(`<div class="toast ${kind}">${message}</div>`);
  host.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 250);
  }, 3200);
}

export function busyButton(button: HTMLButtonElement, busy: boolean, busyText = '推演中…') {
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${busyText}`;
  } else {
    button.disabled = false;
    if (button.dataset.original) button.innerHTML = button.dataset.original;
  }
}
