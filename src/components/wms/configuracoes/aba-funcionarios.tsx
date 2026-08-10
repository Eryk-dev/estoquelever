"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, Field } from "@/components/wms/ui/wms-ui";
import { Avatar } from "@/components/wms/ui/avatar";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { CARGO_LABELS, type Cargo } from "@/types";
import type { GalpaoHierarquiaWms } from "./types";

const CARGOS_EDITAVEIS: Cargo[] = ["admin", "operador", "comprador"];

interface RoleAtiva {
  id: string;
  codigo: string;
  nome: string;
  ativo: boolean;
}

interface GalpaoRef {
  id: string;
  nome: string;
  pode_editar?: boolean;
}

interface Funcionario {
  id: string;
  nome: string;
  cargo: Cargo;
  cargos: Cargo[];
  ativo: boolean;
  foto_url: string | null;
  criado_em: string;
  atualizado_em: string;
  galpoes: GalpaoRef[];
}

function normalizarCargos(cargos: Cargo[]): Cargo[] {
  const norm = cargos.map((c) =>
    c === "operador_cwb" || c === "operador_sp" ? "operador" : c,
  ) as Cargo[];
  return [...new Set(norm)];
}

function CargoChips({ cargos }: { cargos: Cargo[] }) {
  if (cargos.length === 0) return <span className="wms-td-mute">—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {cargos.map((c) => (
        <span
          key={c}
          className="wms-badge"
          style={{
            background: "var(--wms-c-faint)",
            color: "var(--wms-c-fg)",
            fontWeight: 600,
          }}
        >
          {CARGO_LABELS[c] ?? c}
        </span>
      ))}
    </div>
  );
}

function GalpaoChips({ galpoes }: { galpoes: GalpaoRef[] }) {
  if (galpoes.length === 0) return <span className="wms-td-mute">—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {galpoes.map((g) => (
        <span
          key={g.id}
          className="wms-badge"
          style={{
            background: "var(--wms-c-success-faint, #d1fae5)",
            color: "var(--wms-c-success, #047857)",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
          }}
        >
          <Icon name="pin" size={10} />
          {g.nome}
        </span>
      ))}
    </div>
  );
}

function RoleTogglePills({
  roles,
  selecionados,
  onChange,
  disabled,
}: {
  roles: RoleAtiva[];
  selecionados: string[];
  onChange: (roleIds: string[]) => void;
  disabled?: boolean;
}) {
  function toggle(id: string) {
    if (disabled) return;
    const next = selecionados.includes(id)
      ? selecionados.filter((x) => x !== id)
      : [...selecionados, id];
    onChange(next);
  }
  if (roles.length === 0) {
    return (
      <p className="wms-td-mute" style={{ fontSize: 12 }}>
        Nenhuma role ativa. Cadastre uma role primeiro em Permissões.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {roles.map((r) => {
        const ativo = selecionados.includes(r.id);
        return (
          <button
            key={r.id}
            type="button"
            disabled={disabled}
            onClick={() => toggle(r.id)}
            className={`wms-toggle-pill ${ativo ? "is-on" : "is-off"}`}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid var(--wms-c-border)",
              background: ativo
                ? "var(--wms-c-success-faint, #d1fae5)"
                : "var(--wms-c-faint)",
              color: ativo
                ? "var(--wms-c-success, #047857)"
                : "var(--wms-c-mute, #9ca3af)",
              fontSize: 12,
              fontWeight: 600,
              cursor: disabled ? "not-allowed" : "pointer",
            }}
            title={r.codigo}
          >
            {ativo ? "✓ " : "+ "}
            {r.nome}
          </button>
        );
      })}
    </div>
  );
}

function GalpaoTogglePills({
  todos,
  selecionados,
  onChange,
  disabled,
}: {
  todos: GalpaoRef[];
  selecionados: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  if (todos.length === 0) {
    return (
      <p className="wms-td-mute" style={{ fontSize: 12 }}>
        Nenhum galpão ativo. Cadastre um galpão primeiro.
      </p>
    );
  }
  function toggle(id: string) {
    if (disabled) return;
    onChange(
      selecionados.includes(id)
        ? selecionados.filter((x) => x !== id)
        : [...selecionados, id],
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {todos.map((g) => {
        const ativo = selecionados.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            disabled={disabled}
            onClick={() => toggle(g.id)}
            className={`wms-toggle-pill ${ativo ? "is-on" : "is-off"}`}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid var(--wms-c-border)",
              background: ativo
                ? "var(--wms-c-success-faint, #d1fae5)"
                : "var(--wms-c-faint)",
              color: ativo
                ? "var(--wms-c-success, #047857)"
                : "var(--wms-c-mute, #9ca3af)",
              fontSize: 12,
              fontWeight: 600,
              cursor: disabled ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Icon name="pin" size={10} />
            {ativo ? "✓ " : "+ "}
            {g.nome}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// FotoUpload — avatar clicável que abre file picker e dispara o upload.
// Hover mostra overlay "trocar foto". Click longo (botão direito) abre
// menu "Remover foto" se houver foto.
// ─────────────────────────────────────────────────────────────────────
function FotoUpload({
  funcionario,
  podeEditar,
  onMudou,
  size = "sm",
}: {
  funcionario: Funcionario;
  podeEditar: boolean;
  onMudou: () => void;
  size?: "sm" | "md" | "lg";
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  const [hover, setHover] = useState(false);

  async function uploadFoto(file: File) {
    setEnviando(true);
    try {
      const fd = new FormData();
      fd.append("id", funcionario.id);
      fd.append("file", file);
      const r = await sisoFetch("/api/wms/admin/usuarios/foto", {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.erro ?? `HTTP ${r.status}`);
      }
      toast.success("Foto atualizada");
      onMudou();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha no upload");
    } finally {
      setEnviando(false);
    }
  }

  async function removerFoto() {
    if (!confirm(`Remover a foto de ${funcionario.nome}?`)) return;
    setEnviando(true);
    try {
      const r = await sisoFetch(
        `/api/wms/admin/usuarios/foto?id=${funcionario.id}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.erro ?? `HTTP ${r.status}`);
      }
      toast.success("Foto removida");
      onMudou();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao remover");
    } finally {
      setEnviando(false);
    }
  }

  if (!podeEditar) {
    return (
      <Avatar
        nome={funcionario.nome}
        fotoUrl={funcionario.foto_url}
        size={size}
      />
    );
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        if (funcionario.foto_url) {
          e.preventDefault();
          removerFoto();
        }
      }}
      style={{
        position: "relative",
        display: "inline-block",
        cursor: enviando ? "wait" : "pointer",
        opacity: enviando ? 0.6 : 1,
      }}
      onClick={() => !enviando && fileRef.current?.click()}
      title={
        funcionario.foto_url
          ? "Clique pra trocar · botão direito pra remover"
          : "Clique pra adicionar foto"
      }
    >
      <Avatar
        nome={funcionario.nome}
        fotoUrl={funcionario.foto_url}
        size={size}
      />
      {hover && !enviando && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.55)",
            borderRadius: "50%",
            color: "#fff",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          ✎
        </span>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadFoto(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function AbaFuncionarios({
  galpoes,
}: {
  galpoes: GalpaoHierarquiaWms[];
}) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [filtroCargo, setFiltroCargo] = useState<string>("");

  const galpoesAtivos = useMemo<GalpaoRef[]>(
    () =>
      galpoes
        .filter((g) => g.ativo)
        .map((g) => ({ id: g.id, nome: g.nome }))
        .sort((a, b) => a.nome.localeCompare(b.nome)),
    [galpoes],
  );

  const funcionariosQuery = useQuery({
    queryKey: ["wms-cfg-funcionarios"],
    queryFn: () => wmsApi<Funcionario[]>("/api/wms/admin/usuarios"),
  });

  const funcionarios = funcionariosQuery.data ?? [];

  const rolesQuery = useQuery({
    queryKey: ["wms-cfg-roles-ativas"],
    queryFn: async () => {
      const { roles } = await wmsApi<{ roles: RoleAtiva[] }>(
        "/api/wms/admin/roles",
      );
      return roles.filter((r) => r.ativo);
    },
  });

  const rolesAtivas = rolesQuery.data ?? [];

  const filtrados = useMemo(() => {
    if (!filtroCargo) return funcionarios;
    return funcionarios.filter((f) =>
      normalizarCargos(f.cargos?.length ? f.cargos : [f.cargo]).includes(
        filtroCargo as Cargo,
      ),
    );
  }, [funcionarios, filtroCargo]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["wms-cfg-funcionarios"] });
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 className="wms-sec-h" style={{ margin: 0 }}>
            Funcionários
          </h3>
          <p className="wms-td-mute" style={{ fontSize: 12, marginTop: 2 }}>
            Cadastro de usuários com cargo e galpões de acesso. PIN de 4 dígitos
            é usado no login.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            className="wms-select"
            value={filtroCargo}
            onChange={(e) => setFiltroCargo(e.target.value)}
            style={{ minWidth: 180 }}
            title="Filtrar por cargo"
          >
            <option value="">Todos os cargos</option>
            {CARGOS_EDITAVEIS.map((c) => (
              <option key={c} value={c}>
                {CARGO_LABELS[c]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={() => setShowForm((s) => !s)}
          >
            <Icon name="plus" size={12} />
            Novo funcionário
          </button>
        </div>
      </div>

      {showForm && (
        <NovoFuncionarioForm
          galpoes={galpoesAtivos}
          rolesAtivas={rolesAtivas}
          onCancel={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            invalidate();
          }}
        />
      )}

      {funcionariosQuery.isLoading && (
        <div className="wms-loading-pane">Carregando funcionários…</div>
      )}
      {funcionariosQuery.isError && (
        <div className="wms-empty-block">
          <h3>Erro ao carregar funcionários</h3>
          <p>{(funcionariosQuery.error as Error).message}</p>
        </div>
      )}
      {!funcionariosQuery.isLoading && filtrados.length === 0 && (
        <div className="wms-empty-block">
          <h3>
            Nenhum funcionário
            {filtroCargo ? " com esse cargo" : " cadastrado"}
          </h3>
          <p>
            {filtroCargo
              ? "Tente outro cargo ou limpe o filtro."
              : "Cadastre o primeiro funcionário pra começar."}
          </p>
        </div>
      )}
      {filtrados.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Cargos</th>
                <th>Galpões</th>
                <th>Status</th>
                <th style={{ width: 220 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((f) => (
                <LinhaFuncionario
                  key={f.id}
                  funcionario={f}
                  galpoes={galpoesAtivos}
                  rolesAtivas={rolesAtivas}
                  isSelf={f.id === user?.id}
                  editando={editando === f.id}
                  onEditar={() => setEditando(f.id)}
                  onFechar={() => setEditando(null)}
                  onMudou={invalidate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NovoFuncionarioForm({
  galpoes,
  rolesAtivas,
  onCancel,
  onCreated,
}: {
  galpoes: GalpaoRef[];
  rolesAtivas: RoleAtiva[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [nome, setNome] = useState("");
  const [pin, setPin] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [galpaoIds, setGalpaoIds] = useState<string[]>([]);

  // Default selection: role "operador" se existir
  useEffect(() => {
    if (roleIds.length === 0 && rolesAtivas.length > 0) {
      const operador = rolesAtivas.find((r) => r.codigo === "operador");
      if (operador) setRoleIds([operador.id]);
    }
  }, [rolesAtivas, roleIds.length]);

  // Precisa de galpão se alguma role selecionada tem codigo começando com "operador"
  const precisaGalpao = rolesAtivas.some(
    (r) => roleIds.includes(r.id) && r.codigo.startsWith("operador"),
  );

  const criar = useMutation({
    mutationFn: async () => {
      // 1) POST usuário com cargo placeholder derivado da primeira role
      //    selecionada (trigger sincroniza cargos[] a partir de roles após o
      //    PUT abaixo, então isso é só pra atender a validação da rota).
      const VALID_CARGOS = new Set([
        "admin",
        "operador",
        "operador_cwb",
        "operador_sp",
        "comprador",
        "vendedor",
      ]);
      const primeiraRole = rolesAtivas.find((r) => r.id === roleIds[0]);
      const cargoPlaceholder =
        primeiraRole && VALID_CARGOS.has(primeiraRole.codigo)
          ? primeiraRole.codigo
          : "operador";

      const novo = await wmsApi<{ id: string }>("/api/wms/admin/usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: nome.trim(),
          pin,
          cargos: [cargoPlaceholder],
        }),
      });

      // 2) PUT roles do usuário recém-criado (trigger sincroniza cargos[])
      await wmsApi(`/api/wms/admin/usuarios/${novo.id}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role_ids: roleIds }),
      });

      // 3) PUT galpões (se houver)
      if (galpaoIds.length > 0) {
        await wmsApi("/api/wms/admin/usuarios", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: novo.id, galpao_ids: galpaoIds }),
        });
      }

      return novo;
    },
    onSuccess: () => {
      toast.success(`Funcionário ${nome.trim()} criado`);
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const desabilitado =
    !nome.trim() ||
    pin.length !== 4 ||
    roleIds.length === 0 ||
    criar.isPending;

  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 16,
        marginBottom: 16,
      }}
    >
      <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
        Novo funcionário
      </h3>
      <div className="wms-row-3">
        <Field label="Nome" required>
          <input
            className="wms-input"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="ex.: Maria Souza"
            autoFocus
          />
        </Field>
        <Field label="PIN (4 dígitos)" required>
          <input
            className="wms-input wms-mono"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) =>
              setPin(e.target.value.replace(/\D/g, "").slice(0, 4))
            }
            placeholder="0000"
          />
        </Field>
        <div />
      </div>

      <div style={{ marginTop: 12 }}>
        <div
          className="wms-td-mute"
          style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}
        >
          Roles
        </div>
        <RoleTogglePills
          roles={rolesAtivas}
          selecionados={roleIds}
          onChange={setRoleIds}
        />
      </div>

      {precisaGalpao && (
        <div style={{ marginTop: 12 }}>
          <div
            className="wms-td-mute"
            style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}
          >
            Galpões de acesso
          </div>
          <GalpaoTogglePills
            todos={galpoes}
            selecionados={galpaoIds}
            onChange={setGalpaoIds}
          />
          <p
            className="wms-td-mute"
            style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}
          >
            Operadores só veem pedidos e estoque dos galpões marcados.
          </p>
        </div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          paddingTop: 12,
          borderTop: "1px solid var(--wms-c-border)",
          marginTop: 12,
        }}
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={onCancel}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          disabled={desabilitado}
          onClick={() => criar.mutate()}
        >
          <Icon name="check" size={11} />
          {criar.isPending ? "Criando…" : "Criar funcionário"}
        </button>
      </div>
    </div>
  );
}

function LinhaFuncionario({
  funcionario,
  galpoes,
  rolesAtivas,
  isSelf,
  editando,
  onEditar,
  onFechar,
  onMudou,
}: {
  funcionario: Funcionario;
  galpoes: GalpaoRef[];
  rolesAtivas: RoleAtiva[];
  isSelf: boolean;
  editando: boolean;
  onEditar: () => void;
  onFechar: () => void;
  onMudou: () => void;
}) {
  const cargosBase = funcionario.cargos?.length
    ? funcionario.cargos
    : [funcionario.cargo];
  const cargosDisplay = normalizarCargos(cargosBase);

  // Mapeia cargos[] atuais -> role IDs via lookup por codigo nas roles ativas.
  // Heurística de compat: cargos "operador_cwb"/"operador_sp" mapeiam pra
  // role "operador" (mesmo critério do normalizarCargos).
  const initialRoleIds = useMemo(() => {
    const codigosAtuais = new Set<string>(cargosDisplay);
    return rolesAtivas
      .filter((r) => codigosAtuais.has(r.codigo))
      .map((r) => r.id);
  }, [cargosDisplay, rolesAtivas]);

  const [form, setForm] = useState({
    roleIds: initialRoleIds,
    galpaoIds: funcionario.galpoes.map((g) => g.id),
    galpaoEditIds: funcionario.galpoes
      .filter((g) => g.pode_editar !== false)
      .map((g) => g.id),
  });

  // Re-sync quando roles ativas chegam após render inicial (a query roda em
  // paralelo). Sem isso o estado inicial ficaria vazio se a query atrasar.
  useEffect(() => {
    setForm((s) => ({ ...s, roleIds: initialRoleIds }));
  }, [initialRoleIds]);

  // Precisa de galpão se alguma role selecionada tem codigo começando com "operador"
  const precisaGalpao = rolesAtivas.some(
    (r) => form.roleIds.includes(r.id) && r.codigo.startsWith("operador"),
  );

  const salvar = useMutation({
    mutationFn: async () => {
      // 1) PUT roles (trigger sincroniza cargos[])
      await wmsApi(`/api/wms/admin/usuarios/${funcionario.id}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role_ids: form.roleIds }),
      });
      // 2) PUT galpões (sem cargos — trigger já cuidou disso)
      await wmsApi("/api/wms/admin/usuarios", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: funcionario.id,
          galpoes: form.galpaoIds.map((id) => ({
            id,
            pode_editar: form.galpaoEditIds.includes(id),
          })),
        }),
      });
    },
    onSuccess: () => {
      toast.success(`${funcionario.nome} atualizado`);
      onMudou();
      onFechar();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleAtivo = useMutation({
    mutationFn: () =>
      wmsApi("/api/wms/admin/usuarios", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: funcionario.id,
          ativo: !funcionario.ativo,
        }),
      }),
    onSuccess: () => {
      toast.success(
        `${funcionario.nome} ${funcionario.ativo ? "desativado" : "ativado"}`,
      );
      onMudou();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const excluir = useMutation({
    mutationFn: () =>
      wmsApi(`/api/wms/admin/usuarios?id=${funcionario.id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`${funcionario.nome} excluído`);
      onMudou();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { user: viewer } = useAuth();
  const viewerCargos = viewer?.cargos?.length
    ? viewer.cargos
    : viewer?.cargo
      ? [viewer.cargo]
      : [];
  const viewerIsAdmin = viewerCargos.includes("admin");
  const podeEditarFoto = isSelf || viewerIsAdmin;

  if (!editando) {
    return (
      <tr style={{ opacity: funcionario.ativo ? 1 : 0.55 }}>
        <td>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <FotoUpload
              funcionario={funcionario}
              podeEditar={podeEditarFoto}
              onMudou={onMudou}
              size="md"
            />
            <div style={{ minWidth: 0 }}>
              <strong>{funcionario.nome}</strong>
              {isSelf && (
                <span
                  className="wms-badge wms-badge-mute"
                  style={{ marginLeft: 6, fontSize: 10 }}
                >
                  você
                </span>
              )}
            </div>
          </div>
        </td>
        <td>
          <CargoChips cargos={cargosDisplay} />
        </td>
        <td>
          <GalpaoChips galpoes={funcionario.galpoes} />
        </td>
        <td>
          {funcionario.ativo ? (
            <span className="wms-badge wms-badge-ok">Ativo</span>
          ) : (
            <span className="wms-badge wms-badge-mute">Inativo</span>
          )}
        </td>
        <td>
          <div
            style={{
              display: "flex",
              gap: 4,
              justifyContent: "flex-end",
            }}
          >
            {!isSelf && (
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={onEditar}
                title="Editar cargos e galpões"
              >
                <Icon name="edit" size={12} />
                Editar
              </button>
            )}
            {!isSelf && (
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={() => toggleAtivo.mutate()}
                disabled={toggleAtivo.isPending}
                title={funcionario.ativo ? "Desativar" : "Ativar"}
              >
                {funcionario.ativo ? "Desativar" : "Ativar"}
              </button>
            )}
            {!isSelf && (
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={() => {
                  if (
                    confirm(
                      `Excluir ${funcionario.nome}? Vai sumir da lista e perder acesso aos galpões. Histórico fica preservado.`,
                    )
                  ) {
                    excluir.mutate();
                  }
                }}
                disabled={excluir.isPending}
                title="Excluir funcionário"
                style={{ color: "var(--wms-c-danger, #b91c1c)" }}
              >
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ background: "var(--wms-c-panel)" }}>
      <td colSpan={5} style={{ padding: 14 }}>
        <div style={{ marginBottom: 12 }}>
          <strong>{funcionario.nome}</strong>
          <span
            className="wms-td-mute"
            style={{ fontSize: 12, marginLeft: 8 }}
          >
            Editar roles e galpões
          </span>
        </div>

        <div>
          <div
            className="wms-td-mute"
            style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}
          >
            Roles
          </div>
          <RoleTogglePills
            roles={rolesAtivas}
            selecionados={form.roleIds}
            onChange={(roleIds) => setForm((s) => ({ ...s, roleIds }))}
            disabled={salvar.isPending}
          />
        </div>

        {precisaGalpao && (
          <div style={{ marginTop: 12 }}>
            <div
              className="wms-td-mute"
              style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}
            >
              Galpões de acesso
            </div>
            <GalpaoTogglePills
              todos={galpoes}
              selecionados={form.galpaoIds}
              onChange={(galpaoIds) => setForm((s) => ({
                ...s,
                galpaoIds,
                galpaoEditIds: s.galpaoEditIds.filter((id) => galpaoIds.includes(id)),
              }))}
              disabled={salvar.isPending}
            />
            {form.galpaoIds.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="wms-td-mute" style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
                  Pode editar (os demais ficam somente para visualização)
                </div>
                <GalpaoTogglePills
                  todos={galpoes.filter((g) => form.galpaoIds.includes(g.id))}
                  selecionados={form.galpaoEditIds}
                  onChange={(galpaoEditIds) => setForm((s) => ({ ...s, galpaoEditIds }))}
                  disabled={salvar.isPending}
                />
              </div>
            )}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--wms-c-border)",
          }}
        >
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onFechar}
            disabled={salvar.isPending}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={salvar.isPending}
            onClick={() => salvar.mutate()}
            title={
              form.roleIds.length === 0
                ? "Salvar sem roles deixa o usuário sem acesso"
                : undefined
            }
          >
            <Icon name="check" size={11} />
            {salvar.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </td>
    </tr>
  );
}
