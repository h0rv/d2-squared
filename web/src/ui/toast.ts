export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toasts {
  show(text: string, options?: { action?: ToastAction; error?: boolean; ms?: number }): void;
  busy(text: string): void;
  hide(): void;
}

export function mountToasts(el: HTMLElement): Toasts {
  let timer = 0;
  let hiding = 0;

  function hide(): void {
    window.clearTimeout(timer);
    el.classList.remove("show");
    document.body.classList.remove("toasting");
    window.clearTimeout(hiding);
    hiding = window.setTimeout(() => {
      if (!el.classList.contains("show")) el.hidden = true;
    }, 220);
  }

  function open(text: string, error: boolean, action?: ToastAction): void {
    window.clearTimeout(hiding);
    window.clearTimeout(timer);
    const label = document.createElement("span");
    label.textContent = text;
    el.replaceChildren(label);
    el.classList.toggle("error", error);
    if (action) {
      const button = document.createElement("button");
      button.className = "toast-action";
      button.textContent = action.label;
      button.onclick = () => {
        hide();
        action.run();
      };
      el.append(" · ", button);
    }
    el.hidden = false;
    document.body.classList.add("toasting");
    requestAnimationFrame(() => el.classList.add("show"));
  }

  return {
    show(text, options = {}) {
      open(text, options.error ?? false, options.action);
      timer = window.setTimeout(hide, options.ms ?? 4000);
    },
    busy(text) {
      open(text, false);
    },
    hide,
  };
}

export function showTip(tip: HTMLElement, text: string, at: { clientX: number; clientY: number }, touch = false): void {
  if (!text) {
    tip.hidden = true;
    return;
  }
  if (tip.textContent !== text) tip.textContent = text;
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = at.clientX + 16;
  let y = touch ? at.clientY - h - 48 : at.clientY + 20;
  if (x + w > window.innerWidth - 8) x = at.clientX - w - 16;
  if (y + h > window.innerHeight - 8) y = at.clientY - h - 16;
  tip.style.transform = `translate3d(${Math.max(8, x)}px, ${Math.max(8, y)}px, 0)`;
}
