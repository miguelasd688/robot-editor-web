import type { CSSProperties, SelectHTMLAttributes } from "react";

const baseStyle: CSSProperties = {
  height: 28,
  padding: "0 8px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "rgba(255,255,255,0.9)",
  fontSize: 12,
  colorScheme: "dark",
};

const compactStyle: CSSProperties = {
  ...baseStyle,
  height: 22,
  padding: "0 6px",
  borderRadius: 6,
  fontSize: 11,
};

type DarkSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: "sm" | "md";
};

export function DarkSelect({ size = "md", style, className, ...props }: DarkSelectProps) {
  const base = size === "sm" ? compactStyle : baseStyle;
  const mergedClassName = className ? `dark-select ${className}` : "dark-select";
  return <select {...props} className={mergedClassName} style={{ ...base, ...style }} />;
}
