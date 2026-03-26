import type { ReactNode } from "react";

/** Narrow centered column (~Instagram post width) inside the app shell. */
export default function FeedColumn({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[470px] ${className}`.trim()}>{children}</div>;
}
