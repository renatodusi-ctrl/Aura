# AURA Jarvis MVP

AURA e um cockpit local web para um assistente pessoal por voz. Ele roda em `http://127.0.0.1:5173`, usa SQLite local via `node:sqlite` e pode operar de duas formas:

- voz real via OpenAI Realtime/WebRTC quando `OPENAI_API_KEY` esta configurada;
- fallback local sem chave para memorias, tarefas e rotina simples.

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

## Dados locais

O banco SQLite fica em `data/aura.sqlite`. Essa pasta esta no `.gitignore`.
