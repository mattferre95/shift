import type { ButtonHTMLAttributes } from "react";

/**
 * One primary action per screen; everything else is secondary or a text link.
 * The styles live in `index.css` (`.shift-btn-*`) so the tokens stay in one place.
 */
export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "text";
  size?: "md" | "sm";
}) {
  return (
    <button
      type={type}
      className={[
        "shift-btn",
        variant === "text" ? "" : `shift-btn-${size}`,
        `shift-btn-${variant}`,
        className ?? "",
      ].join(" ")}
      {...props}
    />
  );
}
