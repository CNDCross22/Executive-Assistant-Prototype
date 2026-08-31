import type { GraphClient } from './client.js';
import { toWindows } from '../lib/timezone.js';

export interface TaskList { id: string; name: string; wellknown: boolean; }
export interface TodoTask { id: string; title: string; status: string; importance: string; due?: string; body: string; }

export class TasksService {
  constructor(private readonly graph: GraphClient) {}
  async lists(): Promise<TaskList[]> {
    const rows = await this.graph.collect<{ id: string; displayName?: string; isOwner?: boolean; wellknownListName?: string }>('/me/todo/lists', { label: 'tasks.lists' }, 2);
    return rows.map((r) => ({ id: r.id, name: r.displayName ?? 'Tasks', wellknown: Boolean(r.wellknownListName && r.wellknownListName !== 'none') }));
  }
  async list(listId: string, limit = 50): Promise<TodoTask[]> {
    const rows = await this.graph.collect<{ id: string; title?: string; status?: string; importance?: string; dueDateTime?: { dateTime?: string }; body?: { content?: string } }>(`/me/todo/lists/${listId}/tasks`, { label: 'tasks.list' }, 2);
    return rows.slice(0, limit).map((t) => ({ id: t.id, title: t.title ?? '(untitled)', status: t.status ?? 'notStarted', importance: t.importance ?? 'normal', due: t.dueDateTime?.dateTime, body: t.body?.content ?? '' }));
  }
  async create(listId: string, input: { title: string; due?: string; timezone?: string; body?: string; importance?: string }): Promise<{ id: string }> {
    return this.graph.request(`/me/todo/lists/${listId}/tasks`, { method: 'POST', body: { title: input.title, dueDateTime: input.due ? { dateTime: input.due, timeZone: toWindows(input.timezone) } : undefined, body: input.body ? { contentType: 'text', content: input.body } : undefined, importance: input.importance }, label: 'tasks.create' });
  }
  async get(listId: string, taskId: string): Promise<TodoTask> {
    const task = await this.graph.request<{ id: string; title?: string; status?: string; importance?: string; dueDateTime?: { dateTime?: string }; body?: { content?: string } }>(`/me/todo/lists/${listId}/tasks/${taskId}`, { label: 'tasks.get' });
    return { id: task.id, title: task.title ?? '(untitled)', status: task.status ?? 'notStarted', importance: task.importance ?? 'normal', due: task.dueDateTime?.dateTime, body: task.body?.content ?? '' };
  }
  async update(listId: string, taskId: string, changes: Record<string, unknown>): Promise<void> { await this.graph.request(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'PATCH', body: changes, label: 'tasks.update' }); }
  async delete(listId: string, taskId: string): Promise<void> { await this.graph.request(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'DELETE', label: 'tasks.delete' }); }
}
