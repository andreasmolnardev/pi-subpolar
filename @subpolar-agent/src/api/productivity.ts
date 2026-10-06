import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export interface TodoList {
  id: string
  user_id: string
  name: string
  created_at: number
  updated_at: number
}

export interface TodoItem {
  id: string
  user_id: string
  list_id: string
  text: string
  completed: boolean
  created_at: number
  updated_at: number
}

export interface Note {
  id: string
  user_id: string
  title: string
  tags: string[]
  text: string
  created_at: number
  updated_at: number
}

export interface MailAccount {
  id: string
  name: string
  username: string
  fromAddress: string
  folders: Array<{ name: string; role: string }>
}

const jsonHeaders = { 'Content-Type': 'application/json' }

export const productivityApi = {
  getTodos: async (): Promise<{ lists: TodoList[]; items: TodoItem[] }> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/todos`)
  },

  createTodoList: async (name: string): Promise<TodoList> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/todo-lists`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name }),
    })
  },

  deleteTodoList: async (id: string): Promise<{ success: boolean }> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/todo-lists/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  createTodoItem: async (listId: string, text: string): Promise<TodoItem> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/todo-items`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ listId, text }),
    })
  },

  updateTodoItem: async (id: string, data: { text?: string; completed?: boolean }): Promise<TodoItem> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/todo-items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify(data),
    })
  },

  deleteTodoItem: async (id: string): Promise<{ success: boolean }> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/todo-items/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  getNotes: async (): Promise<{ notes: Note[] }> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/notes`)
  },

  createNote: async (note: { title: string; tags: string[]; text: string }): Promise<Note> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/notes`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(note),
    })
  },

  updateNote: async (id: string, note: { title: string; tags: string[]; text: string }): Promise<Note> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/notes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(note),
    })
  },

  deleteNote: async (id: string): Promise<{ success: boolean }> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  getMailAccounts: async (): Promise<{ accounts: MailAccount[] }> => {
    return fetchWrapper(`${API_BASE_URL}/api/productivity/mail/accounts`)
  },
}
