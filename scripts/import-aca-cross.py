#!/usr/bin/env python3
"""
Importa cross ACA<->Royce + OEMs do MASTER_PRODUTOS_ACA_COMPACT.xlsx pro modulo Cross (schema 2026-06-19).

- OEM: coluna `codigos_oem` -> normaliza (so alfanumerico, UPPERCASE) -> siso_produtos.oem (text[]).
  Grava no produto ACA (sku = codigo 6-dig) E no produto Royce equivalente (sku A14...). Uniao com oem existente.
- Link: `rc_matches` (codigo Royce RIxxxxxx) -> acha o produto Royce pelo codigo_fornecedor normalizado
  (siso_produto_fornecedores da ROYCE CONNECT) -> cria par em siso_cross_equivalencias (sku_a<sku_b),
  status='sugestao', fonte='aca'. Idempotente (ON CONFLICT DO NOTHING).
- Qualyair: ignorado (sem produto no sistema).

Conexao: Supabase Management API (env SUPABASE_ACCESS_TOKEN), project staging ehbxpbeijofxtsbezwxd.

Uso:
  python3 scripts/import-aca-cross.py            # dry-run (nao escreve)
  python3 scripts/import-aca-cross.py --apply    # escreve no staging (gera rollback .sql)
"""
import sys, os, re, json, ssl, urllib.request, urllib.error
import openpyxl

XLSX = "MASTER_PRODUTOS_ACA_COMPACT.xlsx"
REF = "ehbxpbeijofxtsbezwxd"
ROYCE_FORN = "ROYCE CONNECT AR CONDICIONADO PARA VEICULOS LTDA"
ROLLBACK = "scripts/aca-cross-rollback.sql"
APPLY = "--apply" in sys.argv
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN")
if not TOKEN:
    raise SystemExit("SUPABASE_ACCESS_TOKEN nao setado (rode apos `supabase login`).")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"


def mgmt(sql):
    body = json.dumps({"query": sql}).encode()
    r = urllib.request.Request(API, data=body, method="POST", headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json",
        "User-Agent": "curl/8.7.1"})
    try:
        return json.load(urllib.request.urlopen(r, context=CTX))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Management API erro {e.code}: {e.read().decode()[:600]}")


def norm(s):
    return re.sub(r"[^A-Za-z0-9]", "", str(s)).upper()


def codigo_valido(v):
    # Codigo OEM / Royce real sempre tem ao menos 1 digito. Filtra ruido do
    # sheet: nomes de marca (DELPHI, SANDEN...), fragmentos (PRC, ACP) e
    # palavras-cabecalho que vazaram (product_code, brand, source_url).
    return bool(v) and bool(re.search(r"[0-9]", v))


def aca_sku(c):
    c = str(c).strip()
    return c.zfill(6) if c.isdigit() else c


def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def sqlstr(s):
    return "'" + str(s).replace("'", "''") + "'"


def sqlarr(items):
    if not items:
        return "'{}'::text[]"
    return "array[" + ",".join(sqlstr(x) for x in items) + "]::text[]"


# 1. parse xlsx
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb["Produtos_Compacto"]
hdr = None
rows = []  # {aca, oems:set, royce:set}
for r in ws.iter_rows(values_only=True):
    if hdr is None:
        hdr = {h: i for i, h in enumerate(r)}
        continue
    cod = r[hdr["codigo"]]
    if cod is None:
        continue
    aca = aca_sku(cod)
    oems = set()
    oem_raw = r[hdr["codigos_oem"]]
    if oem_raw:
        for x in str(oem_raw).split(","):
            v = norm(x)
            if codigo_valido(v):
                oems.add(v)
    royce = set()
    rc_raw = r[hdr["rc_matches"]]
    if rc_raw:
        for x in str(rc_raw).split(","):
            v = norm(x)
            if codigo_valido(v):
                royce.add(v)
    rows.append({"aca": aca, "oems": oems, "royce": royce})
print(f"xlsx: {len(rows)} linhas")

# 2. royce_map: norm(codigo_fornecedor) -> [sku...]
royce_map = {}
res = mgmt(f"""
  select p.sku sku, regexp_replace(upper(pf.codigo_fornecedor),'[^A-Z0-9]','','g') norm
  from siso_produto_fornecedores pf
  join siso_fornecedores f on f.id=pf.fornecedor_id
  join siso_produtos p on p.id=pf.produto_id
  where f.nome={sqlstr(ROYCE_FORN)} and pf.codigo_fornecedor is not null
""")
for r in res:
    royce_map.setdefault(r["norm"], []).append(r["sku"])
print(f"royce_map: {len(royce_map)} codigos norm, {sum(len(v) for v in royce_map.values())} produtos A14")

# 3. existencia + oem atual: ACA (define existencia) e Royce
all_aca = sorted({r["aca"] for r in rows})
existing = {}  # sku -> oem(list)|None  (so os ACA que existem)
for ch in chunks(all_aca, 2000):
    inlist = ",".join(sqlstr(s) for s in ch)
    for r in mgmt(f"select sku, oem from siso_produtos where sku in ({inlist})"):
        existing[r["sku"]] = r["oem"]
royce_skus_all = sorted({s for v in royce_map.values() for s in v})
royce_oem = {}
for ch in chunks(royce_skus_all, 2000):
    inlist = ",".join(sqlstr(s) for s in ch)
    for r in mgmt(f"select sku, oem from siso_produtos where sku in ({inlist})"):
        royce_oem[r["sku"]] = r["oem"]
print(f"ACA existentes: {len(existing)}/{len(all_aca)}")

# 4. matching
oem_target = {}   # sku -> set(oems)
links = set()     # (sku_a, sku_b) com sku_a<sku_b
aca_missing = 0
rc_codes_total = 0
rc_unmatched = set()
rows_with_match = 0
for row in rows:
    aca = row["aca"]
    if aca not in existing:
        if row["oems"] or row["royce"]:
            aca_missing += 1
        continue
    if row["oems"]:
        oem_target.setdefault(aca, set()).update(row["oems"])
    matched_here = False
    for rc in row["royce"]:
        rc_codes_total += 1
        skus = royce_map.get(rc)
        if not skus:
            rc_unmatched.add(rc)
            continue
        for rsku in skus:
            if rsku == aca:
                continue  # produto e seu proprio codigo Royce -> sem self-link (CHECK sku_a<sku_b)
            a, b = (aca, rsku) if aca < rsku else (rsku, aca)
            links.add((a, b))
            matched_here = True
            if row["oems"]:
                oem_target.setdefault(rsku, set()).update(row["oems"])
    if matched_here:
        rows_with_match += 1


def cur_oem(sku):
    v = existing.get(sku, royce_oem.get(sku))
    return set(v) if v else set()


# 5. oem final (uniao com existente) - so os que mudam
oem_writes = {}  # sku -> sorted final list
for sku, want in oem_target.items():
    cur = cur_oem(sku)
    final = cur | want
    if final != cur:
        oem_writes[sku] = sorted(final)

# pares ja existentes (pula)
touched = sorted({s for p in links for s in p})
existing_pairs = set()
for ch in chunks(touched, 1500):
    inlist = ",".join(sqlstr(s) for s in ch)
    for r in mgmt(f"select sku_a, sku_b from siso_cross_equivalencias where sku_a in ({inlist}) or sku_b in ({inlist})"):
        existing_pairs.add((r["sku_a"], r["sku_b"]))
new_links = sorted(links - existing_pairs)

print("\n=== PLANO ===")
print(f"ACA nao encontrados (com oem/royce): {aca_missing}")
print(f"linhas com match Royce: {rows_with_match}")
print(f"codigos Royce no sheet: {rc_codes_total} | nao-casados: {len(rc_unmatched)}")
print(f"links novos ACA<->Royce: {len(new_links)} (ja existiam: {len(links) - len(new_links)})")
aca_w = sum(1 for s in oem_writes if s in existing)
roy_w = len(oem_writes) - aca_w
print(f"produtos c/ oem a atualizar: {len(oem_writes)}  (ACA {aca_w} | Royce {roy_w})")
print(f"total codigos OEM (linhas escritas): {sum(len(v) for v in oem_writes.values())}")
if rc_unmatched:
    print(f"amostra Royce nao-casados: {sorted(rc_unmatched)[:8]}")

if not APPLY:
    print("\nDRY-RUN. Nada escrito. Rode com --apply.")
    sys.exit(0)

# 6. apply - rollback snapshot primeiro
rb = ["-- rollback aca-cross import"]
for sku in oem_writes:
    prev = existing.get(sku, royce_oem.get(sku))
    rb.append(f"update siso_produtos set oem={sqlarr(prev) if prev else 'null'} where sku={sqlstr(sku)};")
for a, b in new_links:
    rb.append(f"delete from siso_cross_equivalencias where sku_a={sqlstr(a)} and sku_b={sqlstr(b)} and fonte='aca';")
with open(ROLLBACK, "w") as f:
    f.write("\n".join(rb) + "\n")
print(f"rollback salvo em {ROLLBACK}")

# escreve oem (set-based)
items = list(oem_writes.items())
for ch in chunks(items, 500):
    vals = ",".join(f"({sqlstr(s)},{sqlarr(o)})" for s, o in ch)
    mgmt(f"update siso_produtos as p set oem=v.oem, atualizado_em=now() from (values {vals}) as v(sku,oem) where p.sku=v.sku;")
print(f"oem atualizado: {len(items)} produtos")

# escreve links
for ch in chunks(new_links, 500):
    vals = ",".join(f"({sqlstr(a)},{sqlstr(b)},'equivalente','sugestao','aca',now(),now())" for a, b in ch)
    mgmt(f"insert into siso_cross_equivalencias (sku_a,sku_b,relacao,status,fonte,criado_em,atualizado_em) values {vals} on conflict (sku_a,sku_b) do nothing;")
print(f"links inseridos: {len(new_links)}")

c1 = mgmt("select count(*) c from siso_produtos where oem is not null and array_length(oem,1)>0")[0]["c"]
c2 = mgmt("select count(*) c from siso_cross_equivalencias where fonte='aca'")[0]["c"]
print(f"\nVERIFY: produtos com oem={c1} | equivalencias fonte=aca={c2}")
