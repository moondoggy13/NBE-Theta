import { Crosshair } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export interface GlassPanelProps {
  children: ReactNode;
  className?: string;
  title?: string;
  withCorners?: boolean;
}

export function GlassPanel({ children, className = "", title, withCorners = false }: GlassPanelProps) {
  return (
    <div
      className={cn(
        "relative bg-white/40 backdrop-blur-2xl border border-white/60 shadow-[0_8px_32px_0_rgba(31,38,135,0.07)] rounded-3xl overflow-hidden",
        className,
      )}
    >
      <div className="absolute inset-0 border-t border-white/80 rounded-3xl pointer-events-none" />
      {withCorners && (
        <>
          <div className="absolute top-3 left-3 w-1 h-1 rounded-full bg-slate-400/50" />
          <div className="absolute top-3 right-3 w-1 h-1 rounded-full bg-slate-400/50" />
          <div className="absolute bottom-3 left-3 w-1 h-1 rounded-full bg-slate-400/50" />
          <div className="absolute bottom-3 right-3 w-1 h-1 rounded-full bg-slate-400/50" />
        </>
      )}
      {title && (
        <div className="px-6 py-3 border-b border-black/5 flex items-center justify-between">
          <span className="text-[10px] tracking-widest text-slate-500 font-mono uppercase">{title}</span>
          <Crosshair size={12} className="text-slate-400" />
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
}
