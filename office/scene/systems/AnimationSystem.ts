import type { AgentEntity } from '../entities/AgentEntity'

/** Drives character animation changes and lightweight idle motion. */
export class AnimationSystem {
  update(entities: Map<string, AgentEntity>, dt: number) {
    for (const entity of entities.values()) {
      entity.updateVisuals(entity.data.state, dt)
    }
  }
}
