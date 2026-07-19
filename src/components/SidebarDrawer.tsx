"use client";

interface SidebarDrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

// Lightweight slide-over used to show the Sidebar (or platform nav) as a drawer on small
// screens. Not built on the shadcn Dialog primitive because that one centers its popup —
// a plain overlay + fixed left panel is simpler and keeps full control over the animation.
export function SidebarDrawer({ open, onClose, children }: SidebarDrawerProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 animate-in fade-in-0 duration-150"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative h-full w-60 max-w-[80vw] shadow-lg animate-in slide-in-from-left duration-200">
        {children}
      </div>
    </div>
  );
}
