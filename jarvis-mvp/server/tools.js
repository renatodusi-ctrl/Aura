import {
  addMemory,
  addTask,
  deleteMemory,
  deleteTask,
  listMemories,
  listTasks,
  recordToolRun,
  updateTask
} from "./memory.js";
import { evaluateToolPolicy } from "./policy.js";

const safeTools = new Map([
  ["memory.add", {
    policyLevel: "read",
    description: "Save a local memory note.",
    run: ({ kind, content }) => addMemory({ kind, content })
  }],
  ["tasks.add", {
    policyLevel: "read",
    description: "Create a persistent task.",
    run: ({ title, dueAt }) => addTask({ title, dueAt })
  }],
  ["tasks.complete", {
    policyLevel: "read",
    description: "Mark a task as complete.",
    run: ({ id }) => updateTask(id, { status: "done" })
  }],
  ["tasks.reopen", {
    policyLevel: "read",
    description: "Reopen a completed task.",
    run: ({ id }) => updateTask(id, { status: "open" })
  }]
]);

const confirmationTools = new Map([
  ["memory.delete", {
    policyLevel: "destructive",
    description: "Delete a local memory note.",
    run: ({ id }) => deleteMemory(id)
  }],
  ["tasks.delete", {
    policyLevel: "destructive",
    description: "Delete a persistent task.",
    run: ({ id }) => deleteTask(id)
  }],
  ["screen.capture.intent", {
    policyLevel: "network",
    description: "Request opt-in browser screen capture from the user.",
    run: () => ({ nextAction: "browser-getDisplayMedia", message: "Screen capture must be accepted in the browser." })
  }]
]);

export function listTools() {
  return [...safeTools, ...confirmationTools].map(([name, tool]) => ({
    name,
    description: tool.description,
    policyLevel: tool.policyLevel,
    requiresConfirmation: evaluateToolPolicy(tool.policyLevel).requiresConfirmation
  }));
}

export function runTool(name, input = {}, confirmed = false) {
  const tool = safeTools.get(name) || confirmationTools.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const policy = evaluateToolPolicy(tool.policyLevel);
  if (policy.requiresConfirmation && !confirmed) {
    recordToolRun(name, "needs_confirmation", input, {});
    return {
      needsConfirmation: true,
      tool: {
        name,
        description: tool.description,
        policyLevel: policy.policyLevel,
        confirmationType: policy.confirmationType,
        input
      }
    };
  }

  const output = tool.run(input);
  recordToolRun(name, "ok", input, output);
  return { needsConfirmation: false, output };
}

export function getLocalContext() {
  return {
    memories: listMemories(10),
    tasks: listTasks(false)
  };
}
