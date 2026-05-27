export type DesktopPlatform = "darwin" | "win32" | "linux" | "other";

export function getDesktopPlatform(): DesktopPlatform {
  const raw = window.electronAPI?.platform ?? "";
  if (raw === "darwin" || raw === "win32" || raw === "linux") return raw;
  return "other";
}

export function useDesktopPlatform(): DesktopPlatform {
  return getDesktopPlatform();
}
