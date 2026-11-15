import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Helper type for tuple of fixed length
export type FixedLengthArray<
  T,
  N extends number,
  R extends unknown[] = [],
> = R["length"] extends N ? R : FixedLengthArray<T, N, [T, ...R]>;
