import { CreditError } from "./errors.js";
import type { UserAccount } from "./types.js";

export interface CreditStore {
  put(user: UserAccount): void;
  get(userId: string): UserAccount | undefined;
  getByAgent(agentId: string): UserAccount | undefined;
}

export class MemoryCreditStore implements CreditStore {
  private readonly users = new Map<string, UserAccount>();
  private readonly agentOwners = new Map<string, string>();

  put(user: UserAccount): void {
    const previous = this.users.get(user.id);
    if (previous) {
      for (const agent of previous.agents) this.agentOwners.delete(agent.id);
    }
    for (const agent of user.agents) {
      const owner = this.agentOwners.get(agent.id);
      if (owner && owner !== user.id) {
        throw new CreditError("duplicate_agent", `Agent ${agent.id} is already linked to another user`);
      }
    }
    const copy = structuredClone(user);
    this.users.set(copy.id, copy);
    for (const agent of copy.agents) this.agentOwners.set(agent.id, copy.id);
  }

  get(userId: string): UserAccount | undefined {
    const user = this.users.get(userId);
    return user ? structuredClone(user) : undefined;
  }

  getByAgent(agentId: string): UserAccount | undefined {
    const userId = this.agentOwners.get(agentId);
    return userId ? this.get(userId) : undefined;
  }
}
