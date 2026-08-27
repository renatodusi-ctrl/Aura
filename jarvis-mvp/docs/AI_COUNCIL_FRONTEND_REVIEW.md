# Conselho de IAs - Revisao de Frontend do AURA

Data: 2026-08-26
Escopo: avaliacao da experiencia do cockpit web local em `http://127.0.0.1:5173`.

## Contexto do produto

AURA e um assistente pessoal local por voz, inspirado no Jarvis, com cockpit web, voz via OpenAI Realtime/WebRTC, fallback local sem chave, memoria SQLite, tarefas persistentes, ferramentas seguras com confirmacao, captura de tela opt-in e rotina diaria opt-in enquanto a aplicacao esta aberta.

O produto esta evoluindo para operar como um assistente conversacional capaz de receber demandas por voz/texto, acionar Codex CLI para execucao, consultar Gemini CLI e Grok CLI como analistas, e sintetizar debates entre modelos.

## Evidencias observadas

Servidor local ativo:

- URL: `http://127.0.0.1:5173`
- Estado de voz observado: `Fallback local`
- Tarefas abertas observadas: `0 tarefas abertas`
- Titulo da pagina: `AURA Cockpit`

Estrutura visual atual:

- Topo com marca `AURA`, etiqueta `Assistente local`, status de voz e tarefas abertas.
- Primeira area: painel grande de `Conversa` com botao `Conectar voz`, campo de texto e botao `Enviar`.
- Lateral: `Rotina`, seletor `analyze/ask`, botao `Sugerir`, area `Tela` com `Capturar`.
- Segunda area: painel `Jobs` com lista de jobs e detalhe do job selecionado.
- Terceira area: `Tarefas`, `Memoria`, `Ferramentas` e `Eventos`.

Estado de exemplo no navegador:

- Job selecionado: `Verify missing Codex path`
- Status do job: `falhou`
- Resumo: `Codex CLI unavailable.`
- Erro: `Codex CLI was not found on PATH.`
- Eventos do job: `job.created`, `codex.detected`, `job.status_changed`
- Ferramentas: `memory.add`, `tasks.add`, `tasks.complete`, `tasks.reopen`, `memory.delete`, `tasks.delete`, `screen.capture.intent`

Sinais de layout e UX observados:

- A primeira dobra em desktop prioriza conversa, rotina e captura, mas o estado do "Conselho de IAs" ainda nao aparece como experiencia central.
- O painel de jobs tem boa densidade operacional, mas fica com linguagem tecnica visivel para usuario final.
- A pagina tem rolagem longa em desktop: cerca de 2009 px de altura em viewport 1280 x 720.
- Nao foi observado overflow horizontal no desktop.
- A interface usa uma linguagem escura, funcional e compacta, com cards/paines retangulares e acentos verde/ambar.
- Ha responsividade basica por media queries em `900px` e `560px`, empilhando cockpit, workspace e jobs.

Arquivos relevantes:

- `index.html`
- `styles.css`
- `app.js`

## Perguntas ao Conselho

Cada IA deve avaliar o frontend atual com foco em experiencia do usuario para um assistente estilo Jarvis local. A resposta deve considerar:

1. Hierarquia de informacao: o que deveria ser a tela principal?
2. Fluxo de uso: como o usuario entende "falar com AURA", "pedir uma demanda", "acionar Codex" e "consultar Gemini/Grok"?
3. Conselho de IAs: como tornar Gemini, Grok e Codex visiveis como uma conversa/debate util, sem virar decoracao?
4. Jobs e seguranca: como mostrar execucao, riscos, confirmacoes e artefatos de forma clara?
5. Visual: quais mudancas melhoram a sensacao de cockpit sofisticado, sem parecer landing page?
6. Acessibilidade/responsividade: riscos e melhorias prioritarias.
7. Proposta priorizada: P0/P1/P2 para proxima evolucao de tela.

## Respostas Individuais

### Gemini CLI

Indisponivel nesta rodada.

Tentativa executada via Gemini CLI em modo consultivo, sem edicao de arquivos. A chamada principal retornou repetidamente erro remoto `503 UNAVAILABLE`, com mensagem de alta demanda do modelo. Uma segunda tentativa com `gemini-2.5-flash` tambem nao produziu resposta, entrando em retry por falha de rede (`fetch failed sending request`). A avaliacao do Gemini deve ser refeita em uma proxima rodada antes de fechar uma decisao final de design.

Impacto na reuniao: sem contribuicao semantica do Gemini. A sintese abaixo usa as respostas do Grok CLI, do Codex CLI e a evidencia local coletada no navegador.

### Grok CLI

Diagnostico principal: a tela atual comunica mais um painel de operacao tecnica do que um assistente Jarvis. O Grok apontou que o produto que queremos construir - demanda por voz/texto, Codex executando, Gemini/Grok analisando e AURA sintetizando - nao aparece como protagonista da primeira dobra.

Pontos fortes destacados:

- Tema escuro, compacto e funcional esta no caminho certo para cockpit.
- A estrutura ja tem os blocos necessarios: conversa, rotina, jobs, memoria, ferramentas, eventos e captura.
- A base de seguranca opt-in ja aparece no produto.

Problemas criticos apontados:

- `Conversa` ainda parece chat generico; nao comunica missao, estado de escuta ou orquestracao.
- `Fallback local` pode parecer erro silencioso, quando deveria ser apresentado como modo valido.
- Jobs ficam abaixo da dobra e usam jargao tecnico.
- `analyze/ask` e lista de ferramentas sao cripticos para usuario final.
- O Conselho de IAs existe como conceito, mas nao como experiencia visivel.
- Em desktop 1280 x 720, a pagina vira um scroll longo; em mobile, ha risco de empilhar widgets sem prioridade.

Recomendacao central do Grok:

- Redesenhar a primeira dobra como `missao + conselho`, nao como `chat + widgets`.
- Mostrar Gemini, Grok e Codex como assentos funcionais com estado: `pronto`, `analisando`, `executando`, `falhou`, `indisponivel`.
- Transformar jobs em demandas humanas com resumo, status, risco, proximo passo e detalhes tecnicos recolhidos.
- Detectar disponibilidade dos CLIs no boot e exibir no header.
- Levar `Tarefas`, `Memoria`, `Ferramentas` e `Eventos` para abas, drawer ou inspector secundario.

### Codex CLI

Diagnostico principal: a tela atual ja tem bons componentes operacionais, mas nao explica rapidamente o fluxo mental do sistema: AURA recebe uma demanda, consulta analistas, pede confirmacao quando necessario, executa e mostra resultado.

Pontos fortes destacados:

- Conversa, jobs, rotina, ferramentas seguras e artefatos ja estao tecnicamente conectados.
- O painel de jobs tem densidade util para operador/desenvolvedor.
- O produto ja tem materia-prima para uma experiencia de cockpit local confiavel.

Problemas criticos apontados:

- A hierarquia de informacao esta fragmentada entre varios paineis.
- Jobs expõem linguagem tecnica como `job.created`, `codex.detected` e `Codex CLI unavailable`.
- O usuario precisa entender "o que pedi", "quem esta trabalhando nisso" e "o que precisa da minha aprovacao" sem abrir logs.
- Gemini/Grok/Codex so devem ocupar espaco se cada um trouxer contribuicao rastreavel.

Recomendacao central do Codex:

- Transformar a primeira dobra em centro operacional do AURA.
- Criar uma timeline da demanda: `Recebido -> Analisando -> Conselho -> Aprovacao -> Execucao -> Resultado`.
- Mostrar a sintese da AURA acima das respostas individuais do conselho.
- Criar uma faixa de aprovacao para acoes sensiveis com: o que sera feito, por que, quais dados serao acessados, risco e botoes de decisao.
- Manter eventos crus e ferramentas em modo avancado, nao como linguagem principal.

## Sintese Do Conselho

Consenso entre Grok e Codex:

1. A tela nao deve ser reorganizada como landing page. Ela deve virar uma sala de comando local, densa e objetiva.
2. A primeira dobra precisa responder tres perguntas: `o que pedi?`, `quem esta trabalhando nisso?`, `o que precisa da minha aprovacao?`.
3. O Conselho de IAs deve ser funcional, nao decorativo. Gemini, Grok e Codex precisam aparecer com papel, estado e contribuicao curta.
4. Jobs devem ser rebatizados/representados como `Demandas` ou `Execucoes`, com linguagem humana por padrao e log tecnico em detalhe recolhido.
5. O modo de voz precisa ter estado explicito: `Ao vivo`, `Local sem chave`, `Desconectado`, `Ouvindo`, `Pensando`, `Falando`, `Aguardando aprovacao`.
6. A seguranca deve ser visualmente central: permissao de escrita, captura de tela, memoria persistente e execucao local devem ter confirmacoes claras.
7. A pagina atual e longa demais para cockpit principal. Tarefas, memoria, ferramentas e eventos devem ir para abas, inspector ou painel secundario.

Divergencias ou enfases diferentes:

- Grok enfatizou mais o preflight dos CLIs no header, para evitar descobrir indisponibilidade de Codex so depois da falha.
- Codex enfatizou mais a timeline de execucao e a separacao entre sintese da AURA e respostas individuais dos analistas.
- Ambos concordam que a sintese da AURA deve ficar acima dos detalhes de Gemini/Grok/Codex.

## Direcao Recomendada

### Norte de experiencia

AURA deve abrir em uma `Missao Ativa`, nao em um dashboard de widgets. A conversa continua sendo o canal principal, mas cada pedido relevante vira uma demanda rastreavel com conselho, status, aprovacao e resultado.

### Layout alvo para a proxima iteracao

Primeira dobra:

- Header compacto: `AURA`, modo de voz, privacidade local, Gemini, Grok, Codex, tarefas abertas.
- Coluna principal: conversa, estado de voz e composer com intencoes claras: `Conversar`, `Consultar conselho`, `Executar com Codex`.
- Centro ou painel destacado: `Demanda atual`, com objetivo, status, proximo passo e timeline.
- Coluna lateral: `Conselho de IAs`, com tres linhas/assentos:
  - Codex: executor local, arquivos, comandos e workspace.
  - Gemini: analise alternativa e amplitude.
  - Grok: critica, riscos e contrapontos.
- Faixa de seguranca quando aplicavel: risco, arquivos/dados provaveis, motivo da permissao e botoes `Aprovar`, `Negar`, `Ver detalhes`.

Segunda camada:

- Inspector da demanda selecionada com abas: `Resumo`, `Conselho`, `Artefatos`, `Eventos tecnicos`.
- Historico de demandas com filtros: `aguardando voce`, `rodando`, `falhou`, `concluido`.
- `Tarefas`, `Memoria`, `Ferramentas` e `Eventos` como abas compactas ou drawer, nao como blocos competindo na home.

### P0

- Renomear e reestruturar `Jobs` para `Demandas` ou `Execucoes`.
- Criar componente visual de `Demanda atual` na primeira dobra.
- Criar painel `Conselho de IAs` com estados para Codex, Gemini e Grok.
- Adicionar preflight visual dos CLIs no header.
- Traduzir erros tecnicos para mensagens acionaveis em portugues.
- Colapsar logs tecnicos por padrao.

### P1

- Criar timeline da demanda: recebido, analisando, conselho, aguardando aprovacao, executando, resultado.
- Reorganizar seguranca/confirmacao em faixa padronizada.
- Converter artefatos em cards acionaveis.
- Melhorar estado de voz/fallback com microcopy humana.
- Transformar rotina em sugestao contextual do dia, nao bloco concorrente.

### P2

- Criar modo compacto e modo engenheiro.
- Melhorar mobile com ordem: demanda ativa, conversa, conselho, historico.
- Adicionar foco visivel, estados sem depender so de cor e targets confortaveis para toque.
- Refinar movimento discreto para voz/modelos pensando, sem efeitos decorativos excessivos.

### Issues Criadas No GitHub

- [#15 Header compacto com preflight visual dos CLIs](https://github.com/renatodusi-ctrl/Aura/issues/15)
- [#16 Renomear e reestruturar Jobs para Demandas](https://github.com/renatodusi-ctrl/Aura/issues/16)
- [#17 Componente Demanda atual na primeira dobra](https://github.com/renatodusi-ctrl/Aura/issues/17)
- [#18 Painel Conselho de IAs com Codex, Gemini e Grok](https://github.com/renatodusi-ctrl/Aura/issues/18)
- [#19 Erros acionaveis em portugues e logs tecnicos colapsados](https://github.com/renatodusi-ctrl/Aura/issues/19)
- [#20 Timeline da demanda e faixa padronizada de seguranca](https://github.com/renatodusi-ctrl/Aura/issues/20)
- [#21 Artefatos acionaveis, voz humana e rotina contextual do dia](https://github.com/renatodusi-ctrl/Aura/issues/21)

### Proxima decisao sugerida

Abrir uma issue de implementacao para a nova primeira dobra: `Missao Ativa + Conselho de IAs + Preflight dos CLIs`. Essa issue deve mudar a experiencia principal antes de adicionar novas capacidades.
