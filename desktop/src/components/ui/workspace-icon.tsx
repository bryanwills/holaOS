import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * WorkspaceIcon — visual identity for a workspace. Renders a
 * deterministic monogram in a pastel-tinted square; the bg hue is
 * derived from a hash of the workspace id (or name fallback) so the
 * same workspace always renders the same color.
 *
 * Forward-compatible: when `workspace.icon` schema lands, this
 * component should pick the stored emoji / Lucide / uploaded image
 * first and fall through to the monogram only when none exists.
 *
 * Same primitive should be used for any "named-thing" identity
 * elsewhere (apps, sessions, skills) — pass any `{ id, name }`-shaped
 * record.
 */
const workspaceIconVariants = cva(
  "inline-flex shrink-0 items-center justify-center font-semibold leading-none tabular-nums select-none",
  {
    variants: {
      size: {
        xs: "size-4 rounded text-[8px]",
        sm: "size-5 rounded text-[9px]",
        md: "size-6 rounded-md text-[10px]",
        lg: "size-8 rounded-md text-xs",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

interface WorkspaceLike {
  id: string;
  name: string;
}

export type WorkspaceIconProps = Omit<ComponentProps<"span">, "children"> &
  VariantProps<typeof workspaceIconVariants> & {
    workspace: WorkspaceLike;
  };

// FNV-1a-ish — fast, deterministic, no crypto needed (purely cosmetic).
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function deriveMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    const first = words[0]?.[0] ?? "";
    const last = words[words.length - 1]?.[0] ?? "";
    const combined = `${first}${last}`.trim();
    if (combined) return combined.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export function WorkspaceIcon({
  workspace,
  size,
  className,
  style,
  ...props
}: WorkspaceIconProps) {
  const seed = workspace.id || workspace.name || "anon";
  const hue = hashSeed(seed) % 360;
  const monogram = deriveMonogram(workspace.name);
  // OKLch keeps perceived lightness consistent across hues — every
  // workspace reads as the same "weight," only the hue changes. The
  // light-bg + darker-fg pairing reads cleanly in both light and dark
  // modes without needing a `.dark` override.
  const bg = `oklch(0.92 0.05 ${hue})`;
  const fg = `oklch(0.38 0.1 ${hue})`;
  return (
    <span
      aria-hidden="true"
      data-slot="workspace-icon"
      className={cn(workspaceIconVariants({ size }), className)}
      style={{ background: bg, color: fg, ...style }}
      {...props}
    >
      {monogram}
    </span>
  );
}
