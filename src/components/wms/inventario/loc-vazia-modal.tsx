"use client";

interface Props {
  locCodigo: string;
  onConfirmar: () => void;
  onCancelar: () => void;
  loading?: boolean;
}

export function LocVaziaModal({ locCodigo, onConfirmar, onCancelar, loading }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 dark:bg-zinc-900">
        <div className="text-center text-5xl">📭</div>
        <h2 className="mt-4 text-center text-xl font-bold">
          Localização <span className="font-mono">{locCodigo}</span> está vazia?
        </h2>
        <p className="mt-2 text-center text-sm text-zinc-600 dark:text-zinc-400">
          Você não bipou nada. Confirme que conferiu a prateleira e ela está realmente vazia.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={onConfirmar}
            className="w-full rounded-lg bg-green-600 px-4 py-3 font-semibold text-white hover:bg-green-700 disabled:opacity-50"
          >
            Sim, está vazia
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onCancelar}
            className="w-full rounded-lg border border-zinc-300 px-4 py-3 font-semibold hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Não, voltar pra contar
          </button>
        </div>
      </div>
    </div>
  );
}
