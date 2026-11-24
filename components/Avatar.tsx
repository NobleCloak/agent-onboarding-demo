import { initialsOf } from "@/lib/seed";

export function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
