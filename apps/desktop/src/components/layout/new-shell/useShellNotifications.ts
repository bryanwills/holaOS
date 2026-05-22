import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Self-contained runtime-notification polling for the new shell. Mirrors the
 * subset of AppShell's `refreshNotifications` flow that the toast stack needs:
 * pull every 3 s, filter to user-visible unread items, expose dismiss /
 * activate handlers. The richer behavior (native OS notifications, control-
 * center suppression, task-proposal merging) intentionally stays out of scope
 * until the new shell wires the surrounding panels.
 */

const POLL_INTERVAL_MS = 3000;
const MAX_TOAST_NOTIFICATIONS = 4;

function notificationMetadataString(
  notification: RuntimeNotificationRecordPayload,
  key: string,
): string | null {
  const raw = notification.metadata[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function notificationTargetSessionId(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  return notificationMetadataString(notification, "session_id");
}

function notificationActionUrl(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  return notificationMetadataString(notification, "action_url");
}

function notificationDeliveryChannel(
  notification: RuntimeNotificationRecordPayload,
): string | null {
  const delivery = notification.metadata.delivery;
  if (
    delivery &&
    typeof delivery === "object" &&
    !Array.isArray(delivery) &&
    typeof (delivery as { channel?: unknown }).channel === "string"
  ) {
    return (delivery as { channel: string }).channel.trim() || null;
  }
  return null;
}

function isSystemCronjobNotification(
  notification: RuntimeNotificationRecordPayload,
): boolean {
  return (
    notification.source_type === "cronjob" &&
    notificationDeliveryChannel(notification) === "system_notification"
  );
}

function shouldIncludeRuntimeNotificationInShell(
  notification: RuntimeNotificationRecordPayload,
): boolean {
  return (
    notification.source_type !== "cronjob" ||
    isSystemCronjobNotification(notification)
  );
}

export interface UseShellNotificationsResult {
  notifications: RuntimeNotificationRecordPayload[];
  dismiss: (notificationId: string) => Promise<void>;
  activate: (notificationId: string) => Promise<{
    workspaceId: string;
    sessionId: string | null;
    actionUrl: string | null;
  } | null>;
}

export function useShellNotifications(): UseShellNotificationsResult {
  const [notifications, setNotifications] = useState<
    RuntimeNotificationRecordPayload[]
  >([]);
  const byIdRef = useRef(
    new Map<string, RuntimeNotificationRecordPayload>(),
  );

  const refresh = useCallback(async (signal: { cancelled: boolean }) => {
    if (!window.electronAPI) return;
    try {
      const response =
        await window.electronAPI.workspace.listNotifications(null, false, {
          includeCronjobSource: true,
        });
      if (signal.cancelled) return;
      const filtered = response.items
        .filter(shouldIncludeRuntimeNotificationInShell)
        .filter((item) => item.state === "unread")
        .sort(
          (left, right) =>
            Date.parse(right.created_at) - Date.parse(left.created_at),
        )
        .slice(0, MAX_TOAST_NOTIFICATIONS);
      byIdRef.current = new Map(filtered.map((item) => [item.id, item]));
      setNotifications(filtered);
    } catch {
      // Transient API failures are non-fatal — next tick reconciles.
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void refresh(signal);
    const timer = window.setInterval(() => {
      void refresh(signal);
    }, POLL_INTERVAL_MS);
    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const dismiss = useCallback(
    async (notificationId: string) => {
      const target = byIdRef.current.get(notificationId);
      if (!target) return;
      setNotifications((current) =>
        current.filter((item) => item.id !== notificationId),
      );
      byIdRef.current.delete(notificationId);
      try {
        await window.electronAPI.workspace.updateNotification(
          target.workspace_id,
          target.id,
          { state: "dismissed" },
        );
      } catch {
        // Reconcile via the next poll.
      }
    },
    [],
  );

  const activate = useCallback(
    async (notificationId: string) => {
      const target = byIdRef.current.get(notificationId);
      if (!target) return null;
      setNotifications((current) =>
        current.filter((item) => item.id !== notificationId),
      );
      byIdRef.current.delete(notificationId);
      try {
        await window.electronAPI.workspace.updateNotification(
          target.workspace_id,
          target.id,
          { state: "read" },
        );
      } catch {
        // Activation continues even if the state-write fails.
      }
      return {
        workspaceId: target.workspace_id.trim(),
        sessionId: notificationTargetSessionId(target),
        actionUrl: notificationActionUrl(target),
      };
    },
    [],
  );

  return { notifications, dismiss, activate };
}
