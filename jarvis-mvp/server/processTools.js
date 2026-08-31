import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WINDOWS_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat"]);

export function filteredToolEnv(extraEnv = {}) {
  const env = {};
  const names = [
    "PATH",
    "Path",
    "HOME",
    "USER",
    "USERNAME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "ProgramFiles",
    "ProgramFiles(x86)"
  ];

  for (const name of names) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }

  const pathValue = env.PATH || env.Path;
  if (pathValue) {
    env.PATH = pathValue;
    env.Path = pathValue;
  }

  if (process.platform === "win32" && !env.PATHEXT) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }

  return { ...env, ...extraEnv };
}

export function envForAnalyst(name) {
  if (name === "gemini") {
    return copyPresentEnv([
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_API_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS"
    ]);
  }

  if (name === "grok") {
    return copyPresentEnv(["GROK_API_KEY", "XAI_API_KEY"]);
  }

  if (name === "openrouter") {
    return copyPresentEnv(["OPENROUTER_API_KEY", "OPENROUTE_API_KEY"]);
  }

  return {};
}

export function prepareToolSpawn(command, args = [], env = filteredToolEnv()) {
  if (process.platform !== "win32") {
    return { command, args, options: {} };
  }

  const geminiShim = resolveGeminiShim(command, env);
  if (geminiShim) {
    return {
      command: process.execPath,
      args: [geminiShim, ...args],
      options: {}
    };
  }

  const resolved = resolveWindowsCommand(command, env);
  if (resolved && WINDOWS_SCRIPT_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return {
      command: env.ComSpec || process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", quoteCmdCommand(resolved, args)],
      options: { windowsVerbatimArguments: true }
    };
  }

  return { command: resolved || command, args, options: {} };
}

export function spawnToolSync(command, args = [], options = {}) {
  const env = options.env || filteredToolEnv();
  const prepared = prepareToolSpawn(command, args, env);
  return spawnSync(prepared.command, prepared.args, {
    ...options,
    ...prepared.options,
    env
  });
}

export function killProcessTree(child, signal = "SIGTERM") {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (killed.status === 0) {
      return;
    }
  }

  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct child kill below.
  }

  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

function copyPresentEnv(names) {
  const env = {};
  for (const name of names) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  return env;
}

function resolveGeminiShim(command, env) {
  const resolved = resolveWindowsCommand(command, env);
  if (!resolved) {
    return null;
  }

  const basename = path.basename(resolved).toLowerCase();
  if (basename !== "gemini" && basename !== "gemini.cmd" && basename !== "gemini.ps1") {
    return null;
  }

  const script = path.join(path.dirname(resolved), "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
  return fs.existsSync(script) ? script : null;
}

function resolveWindowsCommand(command, env) {
  if (path.isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    return resolveExistingCandidate(command, env);
  }

  const pathValue = env.PATH || env.Path || "";
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const resolved = resolveExistingCandidate(path.join(dir, command), env);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function resolveExistingCandidate(candidate, env) {
  const candidates = [];
  if (!path.extname(candidate)) {
    const pathExt = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
    candidates.push(...pathExt.split(";").filter(Boolean).map((extension) => `${candidate}${extension.toLowerCase()}`));
    candidates.push(...pathExt.split(";").filter(Boolean).map((extension) => `${candidate}${extension.toUpperCase()}`));
  }
  candidates.push(candidate);

  return candidates.find((item) => fs.existsSync(item)) || null;
}

function quoteCmdCommand(command, args) {
  const tail = args.length ? ` ${args.map(quoteCmdArg).join(" ")}` : "";
  return `"${quoteCmdExecutable(command)}${tail}"`;
}

function quoteCmdExecutable(value) {
  return `"${escapeCmdValue(value)}"`;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_\-./:=]+$/.test(text)) {
    return text;
  }
  return `"${escapeCmdValue(text)}"`;
}

function escapeCmdValue(value) {
  return String(value)
    .replace(/\r?\n/g, " ")
    .replace(/([()%!^"<>&|])/g, "^$1");
}
