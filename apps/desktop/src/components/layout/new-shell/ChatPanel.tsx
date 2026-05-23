import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ChevronLeft, MessageCircle, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { ChatPane } from "@/components/panes/ChatPane";
import type { AttachmentListItem } from "@/components/panes/ChatPane/types";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
} from "./state/internalTabs";
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  chatPanelViewAtom,
  chatPanelWidthAtom,
  focusModeAtom,
  newTabOpenAtom,
} from "./state/ui";
import type { ChatLayout } from "./useChatLayout";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

// Linear-style ease — flat, no overshoot. Reused for canvas/width
// transitions so the shell feels of a piece with the inbox cards.
const CHAT_EASE = [0.32, 0.72, 0, 1] as const;

interface ChatSessionOpenRequest {
  sessionId: string;
  requestKey: number;
  mode?: "session" | "draft";
}

export function ChatPanel({ layout = "split" }: { layout?: ChatLayout }) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const { openOutput, openUrlInBrowserTab, openFileInInternalTab } =
    useOpenWorkspaceOutput();

  const [view, setView] = useAtom(chatPanelViewAtom);
  const [sessionOpenRequest, setSessionOpenRequest] =
    useState<ChatSessionOpenRequest | null>(null);
  const sessionRequestKeyRef = useRef(0);

  // Reset to chat whenever the workspace changes — the sessions list is
  // workspace-scoped and would otherwise show stale items briefly.
  useEffect(() => {
    setView("chat");
  }, [selectedWorkspaceId, setView]);

  const handleOpenSessionsView = useCallback(() => {
    setView("sessions");
  }, [setView]);

  const handleReturnToChat = useCallback(() => {
    setView("chat");
  }, [setView]);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      const normalized = sessionId.trim();
      if (!normalized) return;
      sessionRequestKeyRef.current += 1;
      setSessionOpenRequest({
        sessionId: normalized,
        requestKey: sessionRequestKeyRef.current,
        mode: "session",
      });
      setView("chat");
    },
    [setView],
  );

  const handleOpenLocalLink = useCallback(
    (href: string) => {
      if (!href.trim()) return;
      openFileInInternalTab(href);
    },
    [openFileInInternalTab],
  );

  // Blob URLs we minted for ephemeral-image tabs, keyed by tab id. Revoke
  // them once the tab is closed (and on unmount) so we don't leak.
  const ephemeralImageBlobUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const map = ephemeralImageBlobUrlsRef.current;
    if (map.size === 0) return;
    const liveIds = new Set(internalTabs.map((t) => t.id));
    for (const [tabId, url] of map.entries()) {
      if (!liveIds.has(tabId)) {
        URL.revokeObjectURL(url);
        map.delete(tabId);
      }
    }
  }, [internalTabs]);

  useEffect(() => {
    return () => {
      const map = ephemeralImageBlobUrlsRef.current;
      for (const url of map.values()) {
        URL.revokeObjectURL(url);
      }
      map.clear();
    };
  }, []);

  const handlePreviewImageAttachment = useCallback(
    (attachment: AttachmentListItem) => {
      const workspacePath = attachment.workspace_path?.trim() || "";
      if (workspacePath) {
        openFileInInternalTab(workspacePath);
        return;
      }
      const file = attachment.file;
      if (!file) return;

      const existing = internalTabs.find(
        (t) => t.kind === "image" && t.id === `att-${attachment.id}`,
      );
      if (existing) {
        setActiveInternalTabId(existing.id);
        return;
      }

      const url = URL.createObjectURL(file);
      const id = `att-${attachment.id}`;
      ephemeralImageBlobUrlsRef.current.set(id, url);
      const tab = {
        id,
        kind: "image" as const,
        dataUrl: url,
        label: attachment.name || file.name || "Image",
        revokeOnClose: true,
      };
      setInternalTabs((prev) => [...prev, tab]);
      setActiveInternalTabId(id);
    },
    [internalTabs, openFileInInternalTab, setActiveInternalTabId, setInternalTabs],
  );

  const isCanvas = layout !== "split";
  const chatPanelWidth = useAtomValue(chatPanelWidthAtom);

  const body =
    view === "sessions" ? (
      <SessionsView
        workspaceId={selectedWorkspaceId || null}
        onBack={handleReturnToChat}
        onOpenSession={handleOpenSession}
      />
    ) : (
      <ChatPane
        variant="embedded"
        onOpenSessions={handleOpenSessionsView}
        onOpenOutput={openOutput}
        onOpenLinkInBrowser={openUrlInBrowserTab}
        onOpenLocalLink={handleOpenLocalLink}
        onPreviewImageAttachment={handlePreviewImageAttachment}
        sessionOpenRequest={sessionOpenRequest}
      />
    );

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col bg-background transition-[width] duration-stride ease-out-expo",
        isCanvas ? "min-w-0 flex-1" : "border-l border-border",
      )}
      style={isCanvas ? undefined : { width: chatPanelWidth }}
    >
      {!isCanvas ? <ChatPanelResizeHandle /> : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          isCanvas && "mx-auto w-full max-w-[760px] px-8",
        )}
      >
        {body}
      </div>
      <AnimatePresence>
        {isCanvas ? <ChatCanvasControls key="canvas-controls" /> : null}
      </AnimatePresence>
    </aside>
  );
}

/**
 * Left-edge drag handle for resizing the chat rail in split mode. Mirrors
 * SidebarResizeHandle's pattern (1px hairline that lights up on hover/drag,
 * full-height col-resize hitbox). Persists width on drop via the atom.
 */
function ChatPanelResizeHandle() {
  const [width, setWidth] = useAtom(chatPanelWidthAtom);
  const draggingRef = useRef(false);
  const [hovering, setHovering] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        // Dragging left grows the panel (panel sits on the right of the
        // shell), so subtract dx instead of adding.
        const next = Math.max(
          CHAT_PANEL_MIN_WIDTH,
          Math.min(CHAT_PANEL_MAX_WIDTH, startWidth - (ev.clientX - startX)),
        );
        setWidth(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setWidth, width],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onDoubleClick={() => setWidth(CHAT_PANEL_DEFAULT_WIDTH)}
      className="absolute top-0 left-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize select-none"
    >
      <div
        className={cn(
          "absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-primary/60 transition-opacity duration-snappy ease-emphasized",
          hovering || draggingRef.current ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

/**
 * Floating control row that sits over the top of the chat canvas in
 * chatOnly / focus modes. `pointer-events-none` on the container so the
 * chat below stays interactive; only the actual buttons receive events.
 * Backdrop blur on the buttons keeps them legible against scrolling
 * content underneath.
 */
function ChatCanvasControls() {
  const { browserState } = useWorkspaceBrowser("user");
  const internalTabs = useAtomValue(internalTabsAtom);
  const [focusMode, setFocusMode] = useAtom(focusModeAtom);
  const openNewTab = useSetAtom(newTabOpenAtom);
  const totalTabsHidden = browserState.tabs.length + internalTabs.length;
  const canExitFocus = focusMode && totalTabsHidden > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ duration: 0.18, ease: CHAT_EASE }}
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-10 items-center gap-1 px-3"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {canExitFocus ? (
          <motion.button
            key="exit-focus"
            type="button"
            layout
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.16, ease: CHAT_EASE }}
            onClick={() => setFocusMode(false)}
            className="window-no-drag pointer-events-auto inline-flex h-7 items-center gap-1 rounded-md bg-background/70 px-2 text-[11px] font-medium text-foreground/55 backdrop-blur-sm ring-1 ring-border/60 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
            title="Show tabs"
          >
            <ChevronLeft className="size-3" strokeWidth={1.75} />
            <span className="tabular-nums">
              {totalTabsHidden} tab{totalTabsHidden === 1 ? "" : "s"}
            </span>
          </motion.button>
        ) : null}
      </AnimatePresence>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          onClick={() => openNewTab(true)}
          className="window-no-drag pointer-events-auto bg-background/70 text-foreground/55 ring-1 ring-border/60 backdrop-blur-sm hover:text-foreground"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </Button>
      </div>
    </motion.div>
  );
}

function SessionsView({
  workspaceId,
  onBack,
  onOpenSession,
}: {
  workspaceId: string | null;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <MessageCircle className="size-3.5 shrink-0 text-foreground/55" strokeWidth={1.75} />
          <span className="truncate">Sessions</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Return to chat"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SubagentSessionsPane
          workspaceId={workspaceId}
          variant="full"
          onOpenSession={(session) => onOpenSession(session.session_id)}
        />
      </div>
    </div>
  );
}
