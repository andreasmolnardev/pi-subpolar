import type { AutomationDefinition, AutomationInput, AutomationUpdate } from "./types.ts";
import type { AutomationServicePorts } from "./ports.ts";
import { validateAutomationInput, validateAutomationUpdate } from "./validation.ts";

export class AutomationService {
  constructor(private readonly ports: AutomationServicePorts) {}

  list(ownerId: string): Promise<AutomationDefinition[]> {
    return this.ports.repository.list(ownerId);
  }

  get(ownerId: string, automationId: string): Promise<AutomationDefinition | undefined> {
    return this.ports.repository.get(ownerId, automationId);
  }

  async create(ownerId: string, input: unknown): Promise<AutomationDefinition> {
    const valid: AutomationInput = validateAutomationInput(input);
    await this.ports.agentAccess.assertCanUse(ownerId, valid.agentId);
    return this.ports.repository.create(ownerId, valid, this.ports.clock.now().toISOString());
  }

  async update(ownerId: string, automationId: string, update: unknown): Promise<AutomationDefinition | undefined> {
    const valid: AutomationUpdate = validateAutomationUpdate(update);
    const current = await this.ports.repository.get(ownerId, automationId);
    if (!current) return undefined;
    if (valid.agentId) await this.ports.agentAccess.assertCanUse(ownerId, valid.agentId);
    return this.ports.repository.update(ownerId, automationId, valid, this.ports.clock.now().toISOString());
  }

  delete(ownerId: string, automationId: string): Promise<boolean> {
    return this.ports.repository.delete(ownerId, automationId);
  }
}
