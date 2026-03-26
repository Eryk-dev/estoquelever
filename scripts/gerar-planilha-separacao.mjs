import { createClient } from '@supabase/supabase-js'
import XLSX from 'xlsx'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE env vars')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

const statusLabels = {
  aguardando_compra: 'Aguardando Compra',
  aguardando_nf: 'Aguardando NF',
  aguardando_separacao: 'Aguardando Separação',
  em_separacao: 'Em Separação',
  separado: 'Separado',
  embalado: 'Embalado',
}

async function main() {
  const { data, error } = await supabase
    .from('siso_pedidos')
    .select('numero, id_pedido_ecommerce, nome_ecommerce, cliente_nome, status_separacao')
    .not('status_separacao', 'is', null)
    .not('status_separacao', 'in', '(expedido,cancelado)')
    .order('updated_at', { ascending: false })

  if (error) {
    console.error('Query error:', error.message)
    process.exit(1)
  }

  console.log(`Found ${data.length} orders in separation`)

  const rows = data.map((row) => ({
    'Pedido Tiny': row.numero || '',
    'Pedido E-commerce': row.id_pedido_ecommerce || '',
    'Loja': row.nome_ecommerce || '',
    'Cliente': row.cliente_nome || '',
    'Status Separação': statusLabels[row.status_separacao] || row.status_separacao,
  }))

  const ws = XLSX.utils.json_to_sheet(rows)

  // Auto-fit column widths
  ws['!cols'] = [
    { wch: 15 }, // Pedido Tiny
    { wch: 25 }, // Pedido E-commerce
    { wch: 20 }, // Loja
    { wch: 40 }, // Cliente
    { wch: 25 }, // Status
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Separação')

  const now = new Date()
  const ts = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false })
    .replace(/\//g, '-').replace(', ', '_').replace(/:/g, '-')
  const outPath = resolve(process.cwd(), `pedidos-separacao_${ts}.xlsx`)
  XLSX.writeFile(wb, outPath)
  console.log(`Saved to ${outPath}`)
}

main()
