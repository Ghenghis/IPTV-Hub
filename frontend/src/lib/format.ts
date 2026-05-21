// Time / age formatting helpers — no external date library.

export function relativeAge(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function statusToDot(status: string): "ok" | "warn" | "err" | "info" | "idle" {
  switch (status) {
    case "ok":
    case "up_to_date":
    case "running":
      return "ok";
    case "update-available":
    case "update_available":
    case "checking":
      return "warn";
    case "error":
      return "err";
    case "updating":
      return "info";
    default:
      return "idle";
  }
}

const sourcePill: Record<string, { label: string; cls: string }> = {
  git: { label: "GIT", cls: "pill--git" },
  "release-binary": { label: "REL", cls: "pill--release" },
  installer: { label: "MSI", cls: "pill--installer" },
  web: { label: "WEB", cls: "pill--web" },
  "tizen-ipk": { label: "TIZEN", cls: "pill--tizen" },
};

export function pillForSource(type: string): { label: string; cls: string } {
  return sourcePill[type] ?? { label: "?", cls: "pill--git" };
}
