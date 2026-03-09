interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-sm text-zinc-400">{message}</p>
    </div>
  );
}
