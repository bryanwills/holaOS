import { useAtom, useSetAtom } from "jotai";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatPane } from "@/components/panes/ChatPane";
import type { AttachmentListItem } from "@/components/panes/ChatPane/types";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { Button } from "@/components/ui/button";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
} from "./state/internalTabs";
import { chatPanelViewAtom } from "./state/ui";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

interface ChatSessionOpenRequest {
  sessionId: string;
  requestKey: number;
  mode?: "session" | "draft";
}

export function ChatPanel() {
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

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background">
      {view === "sessions" ? (
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
      )}
    </aside>
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
          <MessageCircle className="size-3.5 shrink-0 text-foreground/55" />
          <span className="truncate">Sessions</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Return to chat"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
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
