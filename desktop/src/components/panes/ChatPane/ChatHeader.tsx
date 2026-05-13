import {
  ArrowLeft,
  Boxes,
  Clock3,
  Inbox,
  Loader2,
  MessageCircle,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ChatHeaderProps {
  agentName: string;
  workspace: WorkspaceRecordPayload | null;
  subtitle?: string;
  onReturnToMainSession?: () => void;
  onOpenSessions?: () => void;
  onOpenMeetingMode?: () => void;
  meetingModeBusy?: boolean;
  onOpenInbox?: () => void;
  inboxUnreadCount: number;
  onOpenAutomations?: () => void;
  onOpenArtifacts?: () => void;
}

export function ChatHeader({
  agentName,
  workspace,
  subtitle,
  onReturnToMainSession,
  onOpenSessions,
  onOpenMeetingMode,
  meetingModeBusy = false,
  onOpenInbox,
  inboxUnreadCount,
  onOpenAutomations,
  onOpenArtifacts,
}: ChatHeaderProps) {
  const seed = workspace?.id ?? agentName ?? "default";

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AgentAvatar seed={seed} size="sm" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {agentName}
          </span>
          {subtitle ? (
            <span className="truncate text-[11px] leading-tight text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>

      <TooltipProvider delay={250}>
        <div className="flex shrink-0 items-center gap-0.5">
          {onReturnToMainSession ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onReturnToMainSession()}
                    aria-label="Main session"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Main session</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenSessions ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenSessions()}
                    aria-label="Sessions"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <MessageCircle className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Sessions</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenMeetingMode ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenMeetingMode()}
                    aria-label="Meeting Mode"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={meetingModeBusy}
                  >
                    {meetingModeBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Wand2 className="size-4" />
                    )}
                  </Button>
                }
              />
              <TooltipContent>Meeting Mode</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenInbox ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenInbox()}
                    aria-label="Inbox"
                    className="relative text-muted-foreground hover:text-foreground"
                  >
                    <Inbox className="size-4" />
                    {inboxUnreadCount > 0 ? (
                      <StatusDot
                        variant="destructive"
                        size="sm"
                        className="absolute right-1 top-1 border border-card"
                      />
                    ) : null}
                  </Button>
                }
              />
              <TooltipContent>Inbox</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenAutomations ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenAutomations()}
                    aria-label="Automations"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Clock3 className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Automations</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenArtifacts ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenArtifacts()}
                    aria-label="Artifacts"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Boxes className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Artifacts</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </TooltipProvider>
    </div>
  );
}
