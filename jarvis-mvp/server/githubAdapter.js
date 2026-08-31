import { config } from "./config.js";
import { spawnToolSync } from "./processTools.js";
import { redactText } from "./redaction.js";

const GITHUB_HOST = "github.com";
const ISSUE_STATES = new Set(["open", "closed", "all"]);

export function githubStatus() {
  const repo = normalizeGitHubRepo(config.githubRepo);
  const gh = spawnToolSync("gh", ["auth", "status", "-h", GITHUB_HOST], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const hasToken = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const cliAuthenticated = gh.status === 0;

  return {
    repo,
    configured: Boolean(repo) && (cliAuthenticated || hasToken),
    source: cliAuthenticated ? "gh-cli" : hasToken ? "token" : "missing",
    cliAuthenticated,
    hasToken,
    error: cliAuthenticated || hasToken ? null : redactText(gh.stderr || gh.stdout || "GitHub auth not configured.")
  };
}

export async function listGitHubIssues({ state = "open", limit = 30 } = {}) {
  const status = githubStatus();
  if (!status.repo) {
    throw githubError(400, "AURA_GITHUB_REPO nao esta configurado.");
  }

  const normalizedState = normalizeIssueState(state);
  const normalizedLimit = normalizeLimit(limit);
  if (status.cliAuthenticated) {
    return {
      status,
      issues: listIssuesWithGh(status.repo, normalizedState, normalizedLimit)
    };
  }

  if (status.hasToken) {
    return {
      status,
      issues: await listIssuesWithToken(status.repo, normalizedState, normalizedLimit)
    };
  }

  throw githubError(503, "GitHub nao configurado. Rode gh auth login ou configure GITHUB_TOKEN no .env local.");
}

export async function getGitHubIssue(number) {
  const status = githubStatus();
  if (!status.repo) {
    throw githubError(400, "AURA_GITHUB_REPO nao esta configurado.");
  }

  const issueNumber = normalizeIssueNumber(number);
  if (status.cliAuthenticated) {
    return {
      status,
      issue: getIssueWithGh(status.repo, issueNumber)
    };
  }

  if (status.hasToken) {
    return {
      status,
      issue: await getIssueWithToken(status.repo, issueNumber)
    };
  }

  throw githubError(503, "GitHub nao configurado. Rode gh auth login ou configure GITHUB_TOKEN no .env local.");
}

export function normalizeGitHubRepo(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const urlMatch = raw.match(/github\.com[:/](?<owner>[^/\s]+)\/(?<repo>[^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (urlMatch?.groups) {
    return `${urlMatch.groups.owner}/${urlMatch.groups.repo}`;
  }

  const shortMatch = raw.match(/^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (shortMatch?.groups) {
    return `${shortMatch.groups.owner}/${shortMatch.groups.repo}`;
  }

  return raw;
}

export function normalizeGitHubIssue(raw = {}) {
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((label) => typeof label === "string" ? { name: label } : { name: label.name || "" }).filter((label) => label.name)
    : [];
  const author = typeof raw.author === "string" ? { login: raw.author } : raw.author || {};
  return {
    number: Number(raw.number),
    title: redactText(raw.title || ""),
    state: String(raw.state || "").toUpperCase() === "CLOSED" ? "closed" : "open",
    labels,
    author: author.login || "",
    createdAt: raw.createdAt || raw.created_at || "",
    updatedAt: raw.updatedAt || raw.updated_at || "",
    url: raw.url || raw.html_url || "",
    body: redactText(raw.body || "")
  };
}

function listIssuesWithGh(repo, state, limit) {
  const result = spawnToolSync("gh", [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,state,labels,author,createdAt,updatedAt,url,body"
  ], {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  assertGhResult(result, "Nao consegui listar issues do GitHub.");
  return JSON.parse(result.stdout || "[]").map(normalizeGitHubIssue);
}

function getIssueWithGh(repo, issueNumber) {
  const result = spawnToolSync("gh", [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "number,title,state,labels,author,createdAt,updatedAt,url,body"
  ], {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  assertGhResult(result, `Nao consegui ler a issue #${issueNumber}.`);
  return normalizeGitHubIssue(JSON.parse(result.stdout || "{}"));
}

async function listIssuesWithToken(repo, state, limit) {
  const response = await githubFetch(`/repos/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${limit}`);
  return response.filter((item) => !item.pull_request).map(normalizeGitHubIssue);
}

async function getIssueWithToken(repo, issueNumber) {
  return normalizeGitHubIssue(await githubFetch(`/repos/${repo}/issues/${issueNumber}`));
}

async function githubFetch(path) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AURA-local-cockpit"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw githubError(response.status, redactText(data.message || "GitHub API request failed."));
  }
  return data;
}

function assertGhResult(result, fallback) {
  if (result.status === 0) {
    return;
  }
  const message = redactText(result.stderr || result.stdout || fallback);
  throw githubError(result.status === 127 ? 503 : 502, message || fallback);
}

function normalizeIssueState(value) {
  const state = String(value || "open").toLowerCase();
  return ISSUE_STATES.has(state) ? state : "open";
}

function normalizeIssueNumber(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw githubError(400, "Numero da issue invalido.");
  }
  return number;
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    return 30;
  }
  return Math.min(limit, 100);
}

function githubError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
