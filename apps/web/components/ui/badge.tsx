import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant = "positive" | "pending" | "negative" | "neutral";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  positive: "bg-positive-bg text-positive",
  pending: "bg-pending-bg text-pending",
  negative: "bg-negative-bg text-negative",
  neutral: "bg-background text-label-secondary",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  );
}
