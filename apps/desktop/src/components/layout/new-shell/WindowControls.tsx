import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const BUTTON_CLASSES =
  "window-no-drag grid h-7 w-11 shrink-0 place-items-center text-foreground/55 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:bg-foreground/[0.06]";

export function WindowControls() {
  const [state, setState] = useState<DesktopWindowStatePayload>({
    isFullScreen: false,
    isMaximized: false,
    isMinimized: false,
  });

  useEffect(() => {
    let mounted = true;
    void window.electronAPI.ui.getWindowState().then((next) => {
      if (mounted) setState(next);
    });
    const unsubscribe = window.electronAPI.ui.onWindowStateChange((next) => {
      if (mounted) setState(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const isRestored = state.isMaximized || state.isFullScreen;

  return (
    <div className="window-no-drag flex h-full shrink-0 items-stretch">
      <button
        type="button"
        aria-label="Minimize window"
        className={BUTTON_CLASSES}
        onClick={() => void window.electronAPI.ui.minimizeWindow()}
      >
        <Minus className="size-3.5" strokeWidth={2.1} />
      </button>
      <button
        type="button"
        aria-label={isRestored ? "Restore window" : "Maximize window"}
        className={BUTTON_CLASSES}
        onClick={() => void window.electronAPI.ui.toggleWindowSize()}
      >
        {isRestored ? (
          <Copy className="size-3.5" strokeWidth={1.9} />
        ) : (
          <Square className="size-3" strokeWidth={1.9} />
        )}
      </button>
      <button
        type="button"
        aria-label="Close window"
        className={cn(
          BUTTON_CLASSES,
          "hover:bg-destructive/15 hover:text-destructive",
        )}
        onClick={() => void window.electronAPI.ui.closeWindow()}
      >
        <X className="size-3.5" strokeWidth={2.1} />
      </button>
    </div>
  );
}
