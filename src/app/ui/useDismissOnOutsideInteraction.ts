import { useEffect } from "react";
import type { RefObject } from "react";

type UseDismissOnOutsideInteractionOptions = {
  open: boolean;
  refs: Array<RefObject<HTMLElement | null>>;
  onDismiss: () => void;
  closeOnEscape?: boolean;
};

export function useDismissOnOutsideInteraction(options: UseDismissOnOutsideInteractionOptions) {
  const { open, refs, onDismiss, closeOnEscape = true } = options;

  useEffect(() => {
    if (!open) return;

    const isInside = (target: Node | null) => {
      if (!target) return false;
      return refs.some((ref) => {
        const node = ref.current;
        return Boolean(node && node.contains(target));
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      if (isInside(event.target as Node | null)) return;
      onDismiss();
    };

    const onFocusIn = (event: FocusEvent) => {
      if (isInside(event.target as Node | null)) return;
      onDismiss();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!closeOnEscape) return;
      if (event.key !== "Escape") return;
      onDismiss();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeOnEscape, onDismiss, open, ...refs]);
}
