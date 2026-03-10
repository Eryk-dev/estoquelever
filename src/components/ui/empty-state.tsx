interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-sm text-ink-faint">{message}</p>
    </div>
  );
}
