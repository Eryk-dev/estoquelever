# QA C2 — Lighthouse (2026-05-27) — **DEFERIDO**

**Status:** Não executado neste passe. Razão: lighthouse CLI não instalado no ambiente local (`which lighthouse` → not found) e Chrome headless flag (`--chrome-flags="--headless"`) exige binário do Chrome no PATH (`which chrome` → not found também). Apenas o `Google Chrome.app` está disponível em `/Applications/`, que não é trivial de invocar pelo lighthouse-cli.

## O que rodaria

3 URLs × 3 runs cada → mediana:

- `https://estoquelever.vercel.app/wms`
- `https://estoquelever.vercel.app/wms/separacao`
- `https://estoquelever.vercel.app/wms/pedidos`

Targets do plano: Performance ≥ 60, Accessibility ≥ 90, Best Practices ≥ 90.

## Como rodar manualmente

```bash
npm install -g lighthouse
for url in https://estoquelever.vercel.app/wms https://estoquelever.vercel.app/wms/separacao https://estoquelever.vercel.app/wms/pedidos; do
  for i in 1 2 3; do
    lighthouse "$url" --quiet --chrome-flags="--headless" --output=json --output-path="./lh-$(basename $url)-$i.json"
  done
done
```

Alternativa via web: rodar pelo PageSpeed Insights (https://pagespeed.web.dev/) cole URL → "Analisar".

## Próximo passo

Não bloqueia merge do Fix-C. Recomendação: rodar lighthouse pelo PageSpeed Insights uma vez por release pra estabelecer baseline + criar tasks específicas se algum score cair abaixo do target.
