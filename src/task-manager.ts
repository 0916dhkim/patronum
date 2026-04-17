import crypto from "node:crypto";
import type { AgentDef } from "./agents.js";

export interface AgentTask {
  taskId: string;
  agent: string;
  agentDef: AgentDef;
  task: string;
  chatId: string;
  status: "running" | "done" | "cancelled" | "failed";
  threadId: string;
  threadName: string;
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  abortController: AbortController;
}



/** How long to keep completed/failed/cancelled tasks before cleanup (30 minutes) */
const TASK_TTL_MS = 30 * 60 * 1000;

export class TaskManager {
  private tasks = new Map<string, AgentTask>();

  /**
   * Register a new task. Does NOT start execution — caller handles that.
   */
  spawn(
    agentDef: AgentDef,
    task: string,
    chatId: string,
    threadId: string,
    threadName: string
  ): AgentTask {
    const taskId = crypto.randomUUID().slice(0, 8); // short id for readability
    const abortController = new AbortController();

    const agentTask: AgentTask = {
      taskId,
      agent: agentDef.name,
      agentDef,
      task,
      chatId,
      status: "running",
      threadId,
      threadName,
      startedAt: Date.now(),
      abortController,
    };

    this.tasks.set(taskId, agentTask);
    this.cleanupOldTasks();

    return agentTask;
  }

  /**
   * Mark a task as completed with a result.
   */
  complete(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    task.status = "done";
    task.result = result;
    task.completedAt = Date.now();
  }

  /**
   * Mark a task as failed.
   */
  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
  }

  /**
   * Cancel a running task. Returns a human-readable status message.
   */
  cancel(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) return `No task found with id ${taskId}`;

    if (task.status === "done") return `Task ${taskId} already completed.`;
    if (task.status === "cancelled") return `Task ${taskId} already cancelled.`;
    if (task.status === "failed") return `Task ${taskId} already failed.`;

    task.status = "cancelled";
    task.completedAt = Date.now();
    task.abortController.abort();
    return `Task ${taskId} (${task.agent}) cancelled.`;
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * List all tasks for a given chat, most recent first.
   */
  listTasks(chatId: string): AgentTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.chatId === chatId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * List only running tasks for a given chat.
   */
  listRunning(chatId: string): AgentTask[] {
    return this.listTasks(chatId).filter((t) => t.status === "running");
  }

  /**
   * Count all running tasks across all chats.
   */
  countRunning(): number {
    return Array.from(this.tasks.values()).filter((t) => t.status === "running").length;
  }

  /**
   * Get all running tasks across all chats.
   */
  getAllRunning(): AgentTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === "running");
  }

  /**
   * Remove finished tasks older than TASK_TTL_MS.
   */
  private cleanupOldTasks(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (
        task.status !== "running" &&
        task.completedAt &&
        now - task.completedAt > TASK_TTL_MS
      ) {
        this.tasks.delete(id);
      }
    }
  }
}

// Singleton
export const taskManager = new TaskManager();
