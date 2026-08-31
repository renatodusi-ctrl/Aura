# AURA Jarvis MVP

AURA e um cockpit local web para um assistente pessoal por voz. Por padrao ele roda em `http://127.0.0.1:5173`, mas pode usar outra porta com `PORT=5174` quando a porta padrao ja estiver ocupada. Ele usa SQLite local via `node:sqlite` e pode operar de duas formas:

- voz real via OpenAI Realtime/WebRTC ou Gemini Live quando a chave do provider escolhido esta configurada;
- fallback local sem chave para memorias, tarefas e rotina simples.

O cockpit tambem expoe uma faixa `Agora`, alimentada por `/api/now`, para mostrar o estado falavel da sessao: missao ativa, proximo passo, bloqueios, decisao do Conselho, voz e CTA seguro.

## Requisitos

- Windows 10/11.
- Node.js 22 ou superior.
- Chrome ou Edge para microfone, WebRTC e captura de tela.
- `OPENAI_API_KEY` ou `GEMINI_API_KEY` opcional para voz real.

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
VOICE_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

Ou use Gemini Live:

```env
VOICE_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_LIVE_VOICE=Vindemiatrix
```

Reinicie o servidor. A chave nunca e enviada para o navegador; `/api/status` e `/api/voice/health` mostram apenas provider, modelo, voz, latencia do healthcheck e motivo de fallback quando a voz nao estiver disponivel.

## Verificacao

```powershell
scripts\verify.ps1
```

A rubrica de evolucao rumo a uma experiencia estilo J.A.R.V.I.S. fica em `docs/JARVIS_RUBRIC.md` e e validada por `npm run verify`.

## Dados locais

O banco SQLite fica em `data/aura.sqlite`. Essa pasta esta no `.gitignore`.
