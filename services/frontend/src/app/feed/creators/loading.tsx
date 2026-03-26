import Skeleton from '../../../components/ui/Skeleton';

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Skeleton className="h-8 w-56" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    </div>
  );
}

