import type { ActionDefinition, ActionExecution } from "../types.ts";
import type { ActionHandler, ActionHandlerMap } from "../ports.ts";
import type { NotificationAction, StoreAction, ToolAction, WebhookAction } from "../types.ts";
import { validateActionDefinition } from "../validation.ts";

export class ActionRegistry {
  private readonly handlers = new Map<ActionDefinition["type"], ActionHandler<any>>();

  register<T extends ActionDefinition>(type: T["type"], handler: ActionHandler<T>): this {
    if (this.handlers.has(type)) throw new Error(`Action handler already registered: ${type}`);
    this.handlers.set(type, handler);
    return this;
  }

  get(type: ActionDefinition["type"]): ActionHandler<any> | undefined {
    return this.handlers.get(type);
  }

  validate(value: unknown): ActionDefinition {
    return validateActionDefinition(value);
  }

  toMap(): ActionHandlerMap {
    return Object.fromEntries(this.handlers) as ActionHandlerMap;
  }
}

export function actionInputRecord(action: ActionDefinition, result?: ActionExecution): Record<string, unknown> {
  return { actionId: action.id, actionType: action.type, ...(result ? { status: result.status } : {}) };
}

/**
 * Installs the output-store action and accepts host-backed implementations for side effects.
 * Webhook egress, notification delivery, and tool authorization remain host responsibilities.
 */
export function createCoreActionRegistry(handlers: {
  notification?: ActionHandler<NotificationAction>;
  webhook?: ActionHandler<WebhookAction>;
  tool?: ActionHandler<ToolAction>;
} = {}): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register<StoreAction>("store", { async execute({ resolvedInput }) { return resolvedInput; } });
  if (handlers.notification) registry.register("notification", handlers.notification);
  if (handlers.webhook) registry.register("webhook", handlers.webhook);
  if (handlers.tool) registry.register("tool", handlers.tool);
  return registry;
}
