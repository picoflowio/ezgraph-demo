import {
  GraphNode,
  type GraphNodeUpdate,
} from 'ezgraph';
import type { DemoGraphStateType } from '../demo-graph.state.js';

export class Child2Node extends GraphNode<DemoGraphStateType, { joke?: string }> {
  getPrompt(_state: DemoGraphStateType): string {
    return 'You are a concise comedian.';
  }

  async run(
    state: DemoGraphStateType,
  ): Promise<GraphNodeUpdate<DemoGraphStateType>> {
    const joke = await this.llmGateway.generate(
      this.getPrompt(state),
      'Tell one short joke about concurrent work.',
      this.llmConfig(),
    );
    return {
      ...this.save({ joke: joke.value }),
      tokens: joke.usage,
    };
  }
}
