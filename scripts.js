function GERARSEMFIXA() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Etiqueta Endereço");
  
  // Lê as faixas de corredor, horizontal e vertical
  const startCorridorInput = sheet.getRange("B2").getValue();
  const endCorridorInput   = sheet.getRange("B3").getValue();
  const startHorizontal    = parseInt(sheet.getRange("C2").getValue(), 10);
  const endHorizontal      = parseInt(sheet.getRange("C3").getValue(), 10);
  const startVertical      = parseInt(sheet.getRange("D2").getValue(), 10);
  const endVertical        = parseInt(sheet.getRange("D3").getValue(), 10);

  // Obtemos a lista de corredores a percorrer, de acordo com as regras
  const corridorList = getCorridorRange(startCorridorInput, endCorridorInput);

  let zplCode = '';
  let address1 = '', address2 = '';
  let counter = 0;

  // Loop para montar todas as combinações
  for (let corridor of corridorList) {
    for (let horizontal = startHorizontal; horizontal <= endHorizontal; horizontal++) {
      for (let vertical = startVertical; vertical <= endVertical; vertical++) {
        
        // Formata horizontal e vertical com 2 dígitos
        const h = String(horizontal).padStart(2, '0');
        const v = String(vertical).padStart(2, '');
        
        // Monta o endereço (corridor-h-v) já no formato 00
        let address = `${corridor}-${h}-${v}`;
        
        // Agrupa as etiquetas em pares
        if (counter % 2 === 0) {
          address1 = address;
        } else {
          address2 = address;
          
          // Monta o código ZPL para as duas etiquetas lado a lado
          zplCode += 
            `^XA\n^CF0,70\n^LH0,0^FS\n` +
            // Primeira etiqueta
            `^FO10,30^FB400,1,,C^FD${address1}^FS\n` +
            `^BY2,2,70\n^FO20,120^BCN,85,N,N,N^FD${address1}^FS\n` +
            `^FO300,50^BQN,2,4^FDQA,${address1}^FS\n` +
            // Segunda etiqueta
            `^FO450,30^FB400,1,,C^FD${address2}^FS\n` +
            `^BY2,2,70\n^FO460,120^BCN,85,N,N,N^FD${address2}^FS\n` +
            `^FO750,50^BQN,2,4^FDQA,${address2}^FS\n` +
            `^XZ\n`;
            
          // Reseta as variáveis de endereço
          address1 = '';
          address2 = '';
        }
        counter++;
      }
    }
  }

  // Se sobrou uma etiqueta sem par, gera somente ela
  if (address1 !== '') {
    zplCode += 
      `^XA\n^CF0,70\n^LH0,0^FS\n` +
      `^FO10,30^FB400,1,,C^FD${address1}^FS\n` +
      `^BY2,2,70\n^FO20,120^BCN,85,N,N,N^FD${address1}^FS\n` +
      `^FO300,50^BQN,2,4^FDQA,${address1}^FS\n` +
      `^XZ\n`;
  }

  // Salva o código ZPL como um arquivo de texto no Google Drive
  const fileName = "Generated_ZPL_File.txt";
  const folderName = "Endereçamento NetAir"; // Ajuste o nome da pasta conforme necessário
  const folder = DriveApp.getFoldersByName(folderName).next(); // Certifique-se de que a pasta exista
  const file = folder.createFile(fileName, zplCode, MimeType.PLAIN_TEXT);

  // Cria o link de download
  const url = "https://drive.google.com/uc?export=download&id=" + file.getId();
  
  // Escreve o link na célula F2 (ou outra desejada)
  sheet.getRange("F2").setValue(url);
}

/**
 * Retorna uma lista de "corredores" (strings) entre o valor inicial e o valor final,
 * considerando os seguintes cenários:
 * 1. Numérico (ex.: 1 a 3) => [1, 2, 3]
 * 2. Letras únicas (ex.: A a C) => [A, B, C]
 * 3. Módulo fixo (ex.: CP no início e CP no final) => ["CP"]
 * 4. Caso não caiba nos cenários acima, retorna apenas [valorInicial].
 */
function getCorridorRange(startValue, endValue) {
  // Converter para string (segurança), tirar espaços e deixar em maiúsculas
  const start = String(startValue).trim().toUpperCase();
  const end   = String(endValue).trim().toUpperCase();

  // Se forem exatamente iguais, não há intervalo
  if (start === end) {
    return [start];
  }

  // Tenta verificar se são números
  const startNum = parseInt(start, 10);
  const endNum   = parseInt(end, 10);

  // Se ambos forem números válidos, gera intervalo numérico
  if (!isNaN(startNum) && !isNaN(endNum)) {
    const list = [];
    const step = startNum <= endNum ? 1 : -1;
    for (let n = startNum; (step > 0 ? n <= endNum : n >= endNum); n += step) {
      list.push(String(n));
    }
    return list;
  }

  // Se ambos tiverem apenas 1 caractere (são letras únicas?)
  if (start.length === 1 && end.length === 1 && /[A-Z]/.test(start) && /[A-Z]/.test(end)) {
    const list = [];
    const startCharCode = start.charCodeAt(0);
    const endCharCode   = end.charCodeAt(0);
    const step = startCharCode <= endCharCode ? 1 : -1;
    for (let c = startCharCode; (step > 0 ? c <= endCharCode : c >= endCharCode); c += step) {
      list.push(String.fromCharCode(c));
    }
    return list;
  }

  // Caso contrário, assumimos que é um módulo fixo ou algo fora dos cenários acima
  // Retornamos apenas o valor inicial
  return [start];
}

// Adiciona um menu customizado para rodar a função
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('ZPL Generator')
    .addItem('Generate ZPL', 'GERARSEMFIXA')
    .addToUi();
}
function GERARZPL_VERTICAL() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Etiqueta GRANDE");
  
  // Lê as faixas de corredor, horizontal e vertical
  const startCorridorInput = sheet.getRange("B2").getValue();
  const endCorridorInput   = sheet.getRange("B3").getValue();
  const startHorizontal    = parseInt(sheet.getRange("C2").getValue(), 10);
  const endHorizontal      = parseInt(sheet.getRange("C3").getValue(), 10);
  const startVertical      = parseInt(sheet.getRange("D2").getValue(), 10);
  const endVertical        = parseInt(sheet.getRange("D3").getValue(), 10);
  
  // Obtém a lista de corredores conforme as regras definidas
  const corridorList = getCorridorRange(startCorridorInput, endCorridorInput);
  
  let zplCode = '';
  
  // Loop para montar todas as combinações
  for (let corridor of corridorList) {
    for (let horizontal = startHorizontal; horizontal <= endHorizontal; horizontal++) {
      for (let vertical = startVertical; vertical <= endVertical; vertical++) {
        
        // O horizontal é formatado com 2 dígitos (ex.: "09")
        const h = String(horizontal).padStart(2, '0');
        // O vertical é convertido para string sem formatação (ex.: "1")
        const v = String(vertical);
        
        // Monta o endereço no formato: CORREDOR-Horizontal-Vertical (ex.: "P-09-1")
        const address = `${corridor}-${h}-${v}`;
        
        // Gera o código ZPL para cada etiqueta com o layout fornecido
        zplCode += 
          `^XA\n` +
          `^FWR\n` +                      // Rotaciona 90° todos os elementos
          `^CF0,250\n` +                  // Define o tamanho da fonte para 250
          `^LH0,0^FS\n` +
          `^FO450,0^FB1300,0,,C^FD${address}^FS\n` +   // Texto centralizado
          `^BY6,3,200\n` +
          `^FO50,100^BCR,200,N,N,N^FD${address}^FS\n` + // Código de barras rotacionado em 90°
          `^FO50,700^BQN,2,10^FDQA,${address}^FS\n` +    // QR Code
          `^XZ\n`;
      }
    }
  }
  
  // Salva o código ZPL como um arquivo de texto no Google Drive
  const fileName = "Generated_ZPL_Vertical.txt";
  const folderName = "Endereçamento NetAir"; // Certifique-se de que a pasta exista
  const folder = DriveApp.getFoldersByName(folderName).next();
  const file = folder.createFile(fileName, zplCode, MimeType.PLAIN_TEXT);
  
  // Cria o link de download e escreve na célula F2
  const url = "https://drive.google.com/uc?export=download&id=" + file.getId();
  sheet.getRange("F2").setValue(url);
}

/**
 * Retorna uma lista de corredores (strings) entre o valor inicial e o valor final,
 * considerando:
 *   1. Intervalo numérico (ex.: 1 a 3) => ["1", "2", "3"]
 *   2. Letras únicas (ex.: A a C)   => ["A", "B", "C"]
 *   3. Módulo fixo (ex.: CP no início e CP no final) => ["CP"]
 *   4. Caso não se encaixe nos cenários acima, retorna apenas [valorInicial].
 */
function getCorridorRange(startValue, endValue) {
  const start = String(startValue).trim().toUpperCase();
  const end   = String(endValue).trim().toUpperCase();

  if (start === end) {
    return [start];
  }

  const startNum = parseInt(start, 10);
  const endNum   = parseInt(end, 10);

  if (!isNaN(startNum) && !isNaN(endNum)) {
    const list = [];
    const step = startNum <= endNum ? 1 : -1;
    for (let n = startNum; (step > 0 ? n <= endNum : n >= endNum); n += step) {
      list.push(String(n));
    }
    return list;
  }

  if (start.length === 1 && end.length === 1 && /[A-Z]/.test(start) && /[A-Z]/.test(end)) {
    const list = [];
    const startCharCode = start.charCodeAt(0);
    const endCharCode   = end.charCodeAt(0);
    const step = startCharCode <= endCharCode ? 1 : -1;
    for (let c = startCharCode; (step > 0 ? c <= endCharCode : c >= endCharCode); c += step) {
      list.push(String.fromCharCode(c));
    }
    return list;
  }

  return [start];
}

// Adiciona um menu customizado para rodar a função ao abrir a planilha
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('ZPL Generator')
    .addItem('Generate ZPL Vertical', 'GERARZPL_VERTICAL')
    .addToUi();
}
function atualizarLoc() {
  const apiUrlObter   = 'https://api.tiny.com.br/api2/produto.obter.php';
  const apiUrlAlterar = 'https://api.tiny.com.br/api2/produto.alterar.php';
  const planilha      = SpreadsheetApp.getActiveSpreadsheet();
  const aba           = planilha.getSheetByName("Capa");
  
  // Obtém o token na célula J13
  const tokenCelula   = aba.getRange('J13').getValue();
  
  // Carrega IDs dos produtos (coluna E) e respectivas localizações (coluna C)
  const idsProdutos   = aba
    .getRange('E2:E' + aba.getLastRow())
    .getValues()
    .filter(String); // filtra linhas vazias
  const localizacoes  = aba
    .getRange('C2:C' + aba.getLastRow())
    .getValues()
    .map(row => row[0] ? row[0] : ''); // caso seja nulo, transforma em string vazia
  
  // Define onde será escrito o status (coluna F)
  const statusColumn  = aba.getRange('F2:F' + (idsProdutos.length + 1));
  
  const tamanhoDoLote = 20;
  
  for (let j = 0; j < idsProdutos.length; j += tamanhoDoLote) {
    // Cria um array para acumular produtos válidos do lote
    let produtosParaAtualizar = [];
    
    const finalDoLote = Math.min(j + tamanhoDoLote, idsProdutos.length);
    
    // Percorre as linhas deste lote
    for (let i = j; i < finalDoLote; i++) {
      const idProduto             = idsProdutos[i][0];
      const localizacaoAtualizada = localizacoes[i];
      
      // Se o produto foi marcado como "Produto não encontrado", ignorar
      if (idProduto === "Produto não encontrado") {
        statusColumn.getCell(i + 1, 1).setValue('Produto ignorado');
        continue;
      }
      
      // Monta parâmetros para obter dados do produto
      const paramsObter = {
        method: 'post',
        payload: {
          token:   tokenCelula,
          id:      idProduto,
          formato: 'json'
        },
        muteHttpExceptions: true  // permite capturar erros HTTP
      };
      
      // Tenta chamar a API para obter os dados do produto
      let respostaObter, dadosResposta;
      try {
        respostaObter = UrlFetchApp.fetch(apiUrlObter, paramsObter);
      } catch (erro) {
        // Falha na requisição (ex.: problema de rede, 403, etc.)
        statusColumn.getCell(i + 1, 1).setValue('Falha na requisição: ' + erro);
        continue; // ignora este produto e passa para o próximo
      }
      
      // Tenta fazer o parse do JSON de resposta
      try {
        dadosResposta = JSON.parse(respostaObter.getContentText());
      } catch (erro) {
        statusColumn.getCell(i + 1, 1).setValue('Falha no parse JSON: ' + erro);
        continue; // ignora este produto
      }
      
      // Verifica se o produto retornou corretamente
      const dadosProduto = dadosResposta?.retorno?.produto;
      if (!dadosProduto) {
        // Significa que a API não retornou o produto no formato esperado
        statusColumn.getCell(i + 1, 1).setValue('Falha na obtenção dos dados');
        continue;
      }
      
      // Monta o objeto do produto com a localização atualizada
      const produtoAtual = {
        sequencia:        i + 1,
        id:               dadosProduto.id,
        codigo:           dadosProduto.codigo,
        nome:             dadosProduto.nome,
        unidade:          dadosProduto.unidade || 'PC',
        preco:            dadosProduto.preco || 0.1,
        preco_promocional: dadosProduto.preco_promocional,
        ncm:              dadosProduto.ncm,
        origem:           dadosProduto.origem || 0,
        gtin:             dadosProduto.gtin,
        gtin_embalagem:   dadosProduto.gtin_embalagem,
        localizacao:      localizacaoAtualizada, // atualiza localização
        peso_liquido:     dadosProduto.peso_liquido,
        peso_bruto:       dadosProduto.peso_bruto,
        estoque_minimo:   dadosProduto.estoque_minimo,
        estoque_maximo:   dadosProduto.estoque_maximo,
        id_fornecedor:    dadosProduto.id_fornecedor,
        codigo_fornecedor: dadosProduto.codigo_fornecedor,
        codigo_pelo_fornecedor: dadosProduto.codigo_pelo_fornecedor,
        unidade_por_caixa: dadosProduto.unidade_por_caixa,
        preco_custo:      dadosProduto.preco_custo,
        situacao:         dadosProduto.situacao,
        tipo:             dadosProduto.tipo,
        marca:            dadosProduto.marca,
        kit:              dadosProduto.kit,
        descricao:        dadosProduto.descricao_complementar,
      };
      
      // Adiciona o produto válido ao lote de atualização
      produtosParaAtualizar.push({ produto: produtoAtual });
    } // fim for i (lote)
    
    // Se existem produtos para atualizar neste lote, faz a chamada de alteração
    if (produtosParaAtualizar.length > 0) {
      const data = {
        token:   tokenCelula,
        produto: JSON.stringify({ produtos: produtosParaAtualizar }),
        formato: 'json'
      };
      
      const options = {
        method:            'post',
        contentType:       'application/x-www-form-urlencoded',
        payload:           data,
        muteHttpExceptions: true
      };
      
      let response, jsonResponse;
      try {
        response     = UrlFetchApp.fetch(apiUrlAlterar, options);
        jsonResponse = JSON.parse(response.getContentText());
      } catch (erro) {
        // Falha geral na requisição de atualização ou parse da resposta
        Logger.log("Erro geral ao atualizar produtos: " + erro);
        // Marca todos desse lote como falha geral
        produtosParaAtualizar.forEach(item => {
          const seq = item.produto.sequencia;
          statusColumn.getCell(seq, 1).setValue('Falha geral na atualização');
        });
        // Passa para o próximo lote
        continue;
      }
      
      // Se a resposta retornou registros, processa cada um e seta status na planilha
      if (jsonResponse.retorno && jsonResponse.retorno.registros) {
        jsonResponse.retorno.registros.forEach(registro => {
          const sequencia     = parseInt(registro.registro.sequencia, 10);
          const statusRegistro = registro.registro.status;
          
          let statusMessage;
          if (statusRegistro === "OK") {
            statusMessage = 'Atualizado com sucesso';
          } else {
            const erros     = registro.registro.erros || [];
            const msgErros  = erros.map(e => e.erro).join("; ") || 'Erro desconhecido';
            statusMessage   = 'Falha na atualização: ' + msgErros;
          }
          
          statusColumn.getCell(sequencia, 1).setValue(statusMessage);
        });
      } else {
        // Em caso de erro geral no retorno
        Logger.log("Erro geral ao atualizar produtos: " + response.getContentText());
        produtosParaAtualizar.forEach(item => {
          const seq = item.produto.sequencia;
          statusColumn.getCell(seq, 1).setValue('Falha na atualização (retorno inválido)');
        });
      }
    }
    
    // Aguarda 10 segundos antes do próximo lote (para evitar limite de taxa)
    if (finalDoLote < idsProdutos.length) {
      Utilities.sleep(10000);
    }
  }
}
function atualizarINVENTARIO() {
  const apiUrlObter = 'https://api.tiny.com.br/api2/produto.obter.php';
  const apiUrlAlterar = 'https://api.tiny.com.br/api2/produto.alterar.php';
  const apiUrlAtualizarEstoque = 'https://api.tiny.com.br/api2/produto.atualizar.estoque.php';
  const planilha = SpreadsheetApp.getActiveSpreadsheet();
  const aba = planilha.getSheetByName("Capa");
  const tokenCelula = aba.getRange('J13').getValue();
  const idsProdutos = aba.getRange('E2:E' + aba.getLastRow()).getValues().filter(String);
  const localizacoes = aba.getRange('C2:C' + aba.getLastRow()).getValues().map(row => row[0] ? row[0] : '');
  const statusColumn = aba.getRange('F2:F' + (idsProdutos.length + 1));

  const tamanhoDoLote = 20;
  let produtosParaAtualizar = [];
  let indicesNoLote = [];

  // LOG INICIAL
  Logger.log('========================================');
  Logger.log('INÍCIO DA EXECUÇÃO: ' + new Date().toISOString());
  Logger.log('Total de produtos a processar: ' + idsProdutos.length);
  Logger.log('========================================');

  let i = 0;
  while (i < idsProdutos.length) {
    const idProduto = idsProdutos[i][0];
    const localizacaoAtualizada = localizacoes[i];

    // LOG DE PROGRESSO
    Logger.log('---');
    Logger.log('[' + (i + 1) + '/' + idsProdutos.length + '] Processando produto ID: ' + idProduto);

    statusColumn.getCell(i + 1, 1).setValue('Processando...');

    if (idProduto === "Produto não encontrado") {
      Logger.log('[' + (i + 1) + '] IGNORADO - Produto não encontrado');
      statusColumn.getCell(i + 1, 1).setValue('Produto ignorado');
      i++;
      continue;
    }

    try {
      const paramsObter = {
        method: 'post',
        payload: {
          token: tokenCelula,
          id: idProduto,
          formato: 'json'
        },
        muteHttpExceptions: true // Importante para capturar erros HTTP
      };

      Logger.log('[' + (i + 1) + '] Chamando API produto.obter para ID: ' + idProduto);
      
      const respostaObter = UrlFetchApp.fetch(apiUrlObter, paramsObter);
      const respostaTexto = respostaObter.getContentText();
      const httpCode = respostaObter.getResponseCode();
      
      // LOG DA RESPOSTA HTTP
      Logger.log('[' + (i + 1) + '] HTTP Code: ' + httpCode);
      Logger.log('[' + (i + 1) + '] Resposta API (primeiros 500 chars): ' + respostaTexto.substring(0, 500));

      // Verificar código HTTP
      if (httpCode !== 200) {
        Logger.log('[' + (i + 1) + '] ERRO HTTP: ' + httpCode);
        statusColumn.getCell(i + 1, 1).setValue('Erro HTTP: ' + httpCode);
        i++;
        Utilities.sleep(2000); // Pausa após erro
        continue;
      }

      const respostaJson = JSON.parse(respostaTexto);
      
      // Verificar se a API retornou erro
      if (respostaJson.retorno.status === "Erro") {
        const mensagemErro = respostaJson.retorno.erros ? 
          respostaJson.retorno.erros.map(e => e.erro).join("; ") : 
          "Erro desconhecido da API";
        Logger.log('[' + (i + 1) + '] ERRO API: ' + mensagemErro);
        statusColumn.getCell(i + 1, 1).setValue('Erro API: ' + mensagemErro);
        i++;
        Utilities.sleep(2000); // Pausa após erro
        continue;
      }

      const dadosProduto = respostaJson.retorno.produto;
      const tipoRegistroEstoque = aba.getRange('J7').getValue();

      if (dadosProduto) {
        Logger.log('[' + (i + 1) + '] Produto obtido com sucesso: ' + dadosProduto.nome);
        
        // Atualiza o estoque primeiro
        const quantidadeEstoque = aba.getRange('B' + (i + 2)).getValue();
        Logger.log('[' + (i + 1) + '] Atualizando estoque - Tipo: ' + tipoRegistroEstoque + ', Quantidade: ' + quantidadeEstoque);
        
        const estoque = {
          idProduto: idProduto,
          tipo: tipoRegistroEstoque,
          quantidade: quantidadeEstoque,
          observacoes: "Atualização via Google Sheets",
          deposito: "CWB"
        };

        const dataEstoque = {
          token: tokenCelula,
          estoque: JSON.stringify({ estoque: estoque }),
          formato: "json"
        };

        const optionsEstoque = {
          method: 'post',
          payload: dataEstoque,
          muteHttpExceptions: true
        };

        const respostaEstoque = UrlFetchApp.fetch(apiUrlAtualizarEstoque, optionsEstoque);
        Logger.log('[' + (i + 1) + '] Resposta atualização estoque: ' + respostaEstoque.getContentText().substring(0, 300));

        // Adiciona o produto ao lote de atualizações
        const produtoAtual = {
          sequencia: produtosParaAtualizar.length + 1,
          id: dadosProduto.id,
          codigo: dadosProduto.codigo,
          nome: dadosProduto.nome,
          unidade: dadosProduto.unidade || 'PC',
          preco: dadosProduto.preco || 0.1,
          preco_promocional: dadosProduto.preco_promocional,
          ncm: dadosProduto.ncm,
          origem: dadosProduto.origem || 0,
          gtin: dadosProduto.gtin,
          gtin_embalagem: dadosProduto.gtin_embalagem,
          localizacao: localizacaoAtualizada,
          peso_liquido: dadosProduto.peso_liquido,
          peso_bruto: dadosProduto.peso_bruto,
          estoque_minimo: dadosProduto.estoque_minimo,
          estoque_maximo: dadosProduto.estoque_maximo,
          id_fornecedor: dadosProduto.id_fornecedor,
          codigo_fornecedor: dadosProduto.codigo_fornecedor,
          codigo_pelo_fornecedor: dadosProduto.codigo_pelo_fornecedor,
          unidade_por_caixa: dadosProduto.unidade_por_caixa,
          preco_custo: dadosProduto.preco_custo,
          situacao: dadosProduto.situacao,
          tipo: dadosProduto.tipo,
          marca: dadosProduto.marca,
          kit: dadosProduto.kit,
          descricao: dadosProduto.descricao_complementar,
        };

        produtosParaAtualizar.push({produto: produtoAtual});
        indicesNoLote.push(i);
        Logger.log('[' + (i + 1) + '] Produto adicionado ao lote. Tamanho atual do lote: ' + produtosParaAtualizar.length);
      } else {
        Logger.log('[' + (i + 1) + '] FALHA: dadosProduto está vazio/undefined');
        statusColumn.getCell(i + 1, 1).setValue('Falha na obtenção dos dados');
      }
    } catch (error) {
      const detalhesErro = 'Erro: ' + error.toString() + ' | Stack: ' + (error.stack || 'N/A');
      Logger.log('[' + (i + 1) + '] EXCEÇÃO CAPTURADA:');
      Logger.log('  ID Produto: ' + idProduto);
      Logger.log('  Posição: ' + i);
      Logger.log('  Erro: ' + error.toString());
      Logger.log('  Stack: ' + (error.stack || 'N/A'));
      statusColumn.getCell(i + 1, 1).setValue('Erro: ' + error.toString());
    }

    i++;

    // PAUSA ENTRE CADA REQUISIÇÃO para evitar rate limiting
    if (i < idsProdutos.length) {
      Logger.log('[PAUSA] Aguardando 2 segundos antes da próxima requisição...');
      Utilities.sleep(2000);
    }

    // Verifica se o lote está completo ou se chegamos ao final dos produtos
    if (produtosParaAtualizar.length >= tamanhoDoLote || i >= idsProdutos.length) {
      if (produtosParaAtualizar.length > 0) {
        Logger.log('========================================');
        Logger.log('[LOTE] Enviando lote com ' + produtosParaAtualizar.length + ' produtos');
        Logger.log('========================================');
        
        try {
          produtosParaAtualizar.forEach((item, idx) => {
            item.produto.sequencia = idx + 1;
          });

          const data = {
            token: tokenCelula,
            produto: JSON.stringify({produtos: produtosParaAtualizar}),
            formato: "json"
          };

          const options = {
            method: 'post',
            contentType: 'application/x-www-form-urlencoded',
            payload: data,
            muteHttpExceptions: true
          };

          const response = UrlFetchApp.fetch(apiUrlAlterar, options);
          const responseText = response.getContentText();
          const httpCodeLote = response.getResponseCode();
          
          Logger.log('[LOTE] HTTP Code: ' + httpCodeLote);
          Logger.log('[LOTE] Resposta (primeiros 1000 chars): ' + responseText.substring(0, 1000));
          
          const jsonResponse = JSON.parse(responseText);

          if (jsonResponse.retorno && jsonResponse.retorno.registros) {
            Logger.log('[LOTE] Processando ' + jsonResponse.retorno.registros.length + ' registros de resposta');
            
            jsonResponse.retorno.registros.forEach(registro => {
              const sequenciaNoLote = parseInt(registro.registro.sequencia, 10) - 1;
              const indiceOriginal = indicesNoLote[sequenciaNoLote];
              const statusRegistro = registro.registro.status;
              const statusMessage = statusRegistro === "OK" ? 'Atualizado com sucesso' : 'Falha na atualização: ' + (registro.registro.erros && registro.registro.erros.map(e => e.erro).join("; ") || 'Erro desconhecido');
              
              Logger.log('[LOTE] Sequência ' + (sequenciaNoLote + 1) + ' (índice original ' + indiceOriginal + '): ' + statusMessage);
              statusColumn.getCell(indiceOriginal + 1, 1).setValue(statusMessage);
            });
          } else {
            Logger.log('[LOTE] ERRO: Resposta sem registros válidos');
            Logger.log('[LOTE] Resposta completa: ' + responseText);
            indicesNoLote.forEach(idx => {
              statusColumn.getCell(idx + 1, 1).setValue('Erro: Falha na comunicação com API');
            });
          }
        } catch (error) {
          Logger.log('[LOTE] EXCEÇÃO ao enviar lote:');
          Logger.log('  Erro: ' + error.toString());
          Logger.log('  Stack: ' + (error.stack || 'N/A'));
          indicesNoLote.forEach(idx => {
            statusColumn.getCell(idx + 1, 1).setValue('Erro: ' + error.toString());
          });
        }

        // Limpa o lote atual
        produtosParaAtualizar = [];
        indicesNoLote = [];

        // Pausa entre lotes
        if (i < idsProdutos.length) {
          Logger.log('[PAUSA] Aguardando 10 segundos antes do próximo lote...');
          Utilities.sleep(10000);
        }
      }
    }
  }

  // LOG FINAL
  Logger.log('========================================');
  Logger.log('FIM DA EXECUÇÃO: ' + new Date().toISOString());
  Logger.log('========================================');
}
