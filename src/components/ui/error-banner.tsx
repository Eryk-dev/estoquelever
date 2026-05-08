import { AlertTriangle } from "lucide-react";

interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="flex-1 text-sm text-danger">
        <p className="font-medium">Não foi possível carregar.</p>
        <p className="mt-0.5 text-xs opacity-80">{message}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-semibold text-danger underline-offset-2 hover:underline"
        >
          Tentar de novo
        </button>
      )}
    </div>
  );
}
