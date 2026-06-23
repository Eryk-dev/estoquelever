#!/usr/bin/env python3
"""
Importa códigos OEM do MASTER_PRODUTOS_ACA_COMPACT.xlsx para o módulo Cross.

Para cada produto ACA (coluna `codigo`) que já existe como SKU em
siso_produtos_catalogo, insere os códigos da coluna `codigos_oem` em
siso_produto_oems com origem='manual'. O trigger trg_recalc_oems_after_change
denormaliza pro array catalogo.oem[], alimentando a busca/cluster por OEM.

Idempotente: pula pares (sku, oem) que já existem.
Loga os inseridos em scripts/aca-oem-inserted.json para rollback.

Uso:
  python3 scripts/import-aca-oem.py            # dry-run (não escreve)
  python3 scripts/import-aca-oem.py --apply    # escreve no staging
"""
import sys, os, json, ssl, urllib.request, urllib.parse
import openpyxl

XLSX = "MASTER_PRODUTOS_ACA_COMPACT.xlsx"
LOG = "scripts/aca-oem-inserted.json"
ORIGEM = "manual"
APPLY = "--apply" in sys.argv
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE


def env(key):
    with open(".env") as f:
        for line in f:
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1]
    raise SystemExit(f"{key} não encontrado no .env")


URL = env("NEXT_PUBLIC_SUPABASE_URL")
KEY = env("SUPABASE_SERVICE_ROLE_KEY")
HDR = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def req(method, path, body=None, extra=None):
    h = dict(HDR)
    if extra:
        h.update(extra)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + "/rest/v1/" + path, data=data, headers=h, method=method)
    return json.load(urllib.request.urlopen(r, context=CTX))


def norm(c):
    c = str(c).strip()
    return c.zfill(6) if c.isdigit() else c


def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


# 1. parse xlsx -> {sku: [oem...]}
wb = openpyxl.load_workbook(XLSX, read_only=True)
ws = wb.active
hdr = None
data = {}
for row in ws.iter_rows(values_only=True):
    if hdr is None:
        hdr = {h: i for i, h in enumerate(row)}
        continue
    oem = row[hdr["codigos_oem"]]
    if not oem:
        continue
    sku = norm(row[hdr["codigo"]])
    codes = sorted({c.strip() for c in str(oem).split(",") if c.strip()})
    if codes:
        data[sku] = codes
print(f"xlsx: {len(data)} produtos ACA com OEM")

# 2. quais SKUs existem no catálogo
skus = list(data.keys())
existem = set()
for ch in chunks(skus, 120):
    q = "sku=in.(" + ",".join(urllib.parse.quote(s) for s in ch) + ")&select=sku"
    for r in req("GET", "siso_produtos_catalogo?" + q):
        if r["sku"] in data:
            existem.add(r["sku"])
print(f"casam no catálogo: {len(existem)}")

# 3. pares (sku, oem) já existentes em siso_produto_oems
ja = set()
existem_l = sorted(existem)
for ch in chunks(existem_l, 120):
    q = "produto_sku=in.(" + ",".join(urllib.parse.quote(s) for s in ch) + ")&select=produto_sku,oem_code"
    for r in req("GET", "siso_produto_oems?" + q):
        ja.add((r["produto_sku"], r["oem_code"]))

# 4. pares novos
novos = []
for sku in existem_l:
    for oem in data[sku]:
        if (sku, oem) not in ja:
            novos.append({"produto_sku": sku, "oem_code": oem, "origem": ORIGEM})
print(f"OEM já presentes (pulados): {sum(len(data[s]) for s in existem) - len(novos)}")
print(f"OEM NOVOS a inserir: {len(novos)}")

if not APPLY:
    print("\nDRY-RUN. Nada escrito. Rode com --apply pra inserir.")
    sys.exit(0)

# 5. insere em lotes, loga inseridos
inseridos = []
for ch in chunks(novos, 500):
    res = req("POST", "siso_produto_oems?select=id,produto_sku,oem_code", ch,
              {"Prefer": "return=representation"})
    inseridos.extend(res)
    print(f"  inseridos {len(inseridos)}/{len(novos)}")

with open(LOG, "w") as f:
    json.dump(inseridos, f)
print(f"\nOK: {len(inseridos)} OEM inseridos. Rollback log em {LOG}")
print("Rollback: DELETE FROM siso_produto_oems WHERE id IN (ids do log).")
