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
