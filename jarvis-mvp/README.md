# AURA Jarvis MVP

AURA e um cockpit local web para um assistente pessoal por voz. Por padrao ele roda em `http://127.0.0.1:5173`, mas pode usar outra porta com `PORT=5174` quando a porta padrao ja estiver ocupada. Ele usa SQLite local via `node:sqlite` e pode operar de duas formas:

- voz real via OpenAI Realtime/WebRTC quando `OPENAI_API_KEY` esta configurada;
- fallback local sem chave para memorias, tarefas e rotina simples.

O cockpit tambem expoe uma faixa `Agora`, alimentada por `/api/now`, para mostrar o estado falavel da sessao: missao ativa, proximo passo, bloqueios, decisao do Conselho, voz e CTA seguro.

## Requisitos

- Windows 10/11.
- Node.js 22 ou superior.
- Chrome ou Edge para microfone, WebRTC e captura de tela.
- `OPENAI_API_KEY` opcional.

## Primeira execucao

```powershell
cd jarvis-mvp
scripts\setup.ps1
scripts\run.ps1
```

Abra `http://127.0.0.1:5173`.

Se a porta `5173` ja estiver em uso:

```powershell
$env:PORT="5174"
npm start
```

Abra `http://127.0.0.1:5174`.

## Ativar voz real

Copie `.env.example` para `.env` e preencha:

```env
OPENAI_API_KEY=sk-...
```

Reinicie o servidor. A chave nunca e enviada para o navegador; o servidor cria um segredo efemero para o cliente.

## Verificacao

```powershell
scripts\verify.ps1
```

A rubrica de evolucao rumo a uma experiencia estilo J.A.R.V.I.S. fica em `docs/JARVIS_RUBRIC.md` e e validada por `npm run verify`.

## Dados locais

O banco SQLite fica em `data/aura.sqlite`. Essa pasta esta no `.gitignore`.
