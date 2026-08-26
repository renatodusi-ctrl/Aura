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

const safeTools = new Map([
  ["memory.add", {
    requiresConfirmation: false,
    description: "Save a local memory note.",
    run: ({ kind, content }) => addMemory({ kind, content })
  }],
  ["tasks.add", {
    requiresConfirmation: false,
    description: "Create a persistent task.",
    run: ({ title, dueAt }) => addTask({ title, dueAt })
  }],
  ["tasks.complete", {
    requiresConfirmation: false,
    description: "Mark a task as complete.",
    run: ({ id }) => updateTask(id, { status: "done" })
  }],
  ["tasks.reopen", {
    requiresConfirmation: false,
    description: "Reopen a completed task.",
    run: ({ id }) => updateTask(id, { status: "open" })
  }]
]);

const confirmationTools = new Map([
  ["memory.delete", {
    requiresConfirmation: true,
    description: "Delete a local memory note.",
    run: ({ id }) => deleteMemory(id)
  }],
  ["tasks.delete", {
    requiresConfirmation: true,
    description: "Delete a persistent task.",
    run: ({ id }) => deleteTask(id)
  }],
  ["screen.capture.intent", {
    requiresConfirmation: true,
    description: "Request opt-in browser screen capture from the user.",
    run: () => ({ nextAction: "browser-getDisplayMedia", message: "Screen capture must be accepted in the browser." })
  }]
]);

export function listTools() {
  return [...safeTools, ...confirmationTools].map(([name, tool]) => ({
    name,
    description: tool.description,
    requiresConfirmation: tool.requiresConfirmation
  }));
}

export function runTool(name, input = {}, confirmed = false) {
  const tool = safeTools.get(name) || confirmationTools.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  if (tool.requiresConfirmation && !confirmed) {
    recordToolRun(name, "needs_confirmation", input, {});
    return {
      needsConfirmation: true,
      tool: {
        name,
        description: tool.description,
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
