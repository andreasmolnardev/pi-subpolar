import type { TriggerDefinition, TriggerInput, TriggerKind } from "../types.ts";
import { validateTriggerDefinition } from "../validation.ts";

export interface TriggerAdapter<T extends TriggerDefinition = TriggerDefinition> {
  readonly type: T["type"];
  validate(value: unknown): T;
  /** Delivery authentication, schedule polling, and event subscription are supplied by the host. */
  accept(input: { definition: T; payload: unknown; occurredAt: string }): TriggerInput;
}

export class TriggerRegistry {
  private readonly adapters = new Map<TriggerKind, TriggerAdapter<any>>();

  register<T extends TriggerDefinition>(adapter: TriggerAdapter<T>): this {
    if (this.adapters.has(adapter.type)) throw new Error(`Trigger adapter already registered: ${adapter.type}`);
    this.adapters.set(adapter.type, adapter);
    return this;
  }

  get(type: TriggerKind): TriggerAdapter<any> | undefined {
    return this.adapters.get(type);
  }

  validate(value: unknown): TriggerDefinition {
    const definition = validateTriggerDefinition(value);
    const adapter = this.adapters.get(definition.type);
    if (!adapter) throw new Error(`Trigger adapter is not registered: ${definition.type}`);
    return adapter.validate(definition);
  }

  types(): TriggerKind[] {
    return [...this.adapters.keys()];
  }
}

export function createCoreTriggerRegistry(): TriggerRegistry {
  const registry = new TriggerRegistry();
  for (const type of ["manual", "schedule", "webhook", "event"] as const) {
    registry.register({
      type,
      validate: (value) => validateTriggerDefinition(value) as Extract<TriggerDefinition, { type: typeof type }>,
      accept: ({ payload, occurredAt }) => ({ kind: type, payload: payload as TriggerInput["payload"], occurredAt }),
    });
  }
  return registry;
}
