export interface PageHandle {
  el: HTMLElement;
  destroy?: () => void;
}
