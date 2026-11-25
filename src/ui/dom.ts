export type Child = Node | string | number | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'value' && node instanceof HTMLInputElement) {
      node.value = String(value);
    } else if (key === 'checked' && node instanceof HTMLInputElement) {
      node.checked = Boolean(value);
    } else {
      node.setAttribute(key, String(value === true ? '' : value));
    }
  }
  for (const child of children.flat()) {
    if (child === false || child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    input,
    hint ? h('small', { class: 'field-hint' }, hint) : null,
  );
}

export function numberInput(value: number, onValue: (v: number) => void, opts: { step?: number; min?: number; max?: number; disabled?: boolean } = {}): HTMLInputElement {
  const input = h('input', {
    type: 'number',
    class: 'input num',
    value,
    step: opts.step ?? 'any',
    ...(opts.min !== undefined ? { min: opts.min } : {}),
    ...(opts.max !== undefined ? { max: opts.max } : {}),
    ...(opts.disabled ? { disabled: true } : {}),
  }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onValue(v);
  });
  return input;
}

export function textInput(value: string, onValue: (v: string) => void, opts: { placeholder?: string } = {}): HTMLInputElement {
  const input = h('input', { type: 'text', class: 'input', value, placeholder: opts.placeholder ?? '' }) as HTMLInputElement;
  input.addEventListener('change', () => onValue(input.value));
  return input;
}

export function selectInput<T extends string>(value: T, options: Array<[T, string]>, onValue: (v: T) => void): HTMLSelectElement {
  const select = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const [v, label] of options) {
    const opt = h('option', { value: v }, label) as HTMLOptionElement;
    if (v === value) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => onValue(select.value as T));
  return select;
}

export function checkboxInput(value: boolean, onValue: (v: boolean) => void): HTMLInputElement {
  const input = h('input', { type: 'checkbox', class: 'checkbox', checked: value }) as HTMLInputElement;
  input.addEventListener('change', () => onValue(input.checked));
  return input;
}

export function card(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' },
    h('header', { class: 'card-header' }, h('h2', {}, title)),
    h('div', { class: 'card-body' }, ...children),
  );
}

export function button(label: string, onClick: () => void, opts: { variant?: 'primary' | 'ghost' | 'danger' | 'success'; icon?: string; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  const cls = ['btn', opts.variant ? `btn-${opts.variant}` : '', opts.icon ? 'has-icon' : ''].filter(Boolean).join(' ');
  return h('button', {
    class: cls,
    type: 'button',
    ...(opts.disabled ? { disabled: true } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    onClick: () => onClick(),
  }, opts.icon ? h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, opts.icon) : null, label) as HTMLButtonElement;
}

export function stat(label: string, value: string, sub = '', tone: '' | 'good' | 'warn' | 'bad' | 'accent' = ''): HTMLElement {
  return h('div', { class: `stat ${tone ? `stat-${tone}` : ''}` },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null,
  );
}

export function formatSeconds(t: number): string {
  const sign = t < 0 ? '-' : '';
  const s = Math.abs(Math.round(t));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${sign}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

export function download(filename: string, content: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
