import {
  GraphNode,
  type GraphNodeUpdate,
} from 'ezgraph';
import {
  addTokenUsage,
  emptyTokenUsage,
} from 'ezgraph';
import type { DemoGraphStateType } from '../demo-graph.state.js';

/** A single graph node that manually performs four concurrent model calls. */
export class ManualConcurrentNode extends GraphNode<
  DemoGraphStateType,
  { task?: Record<string, string> }
> {
  getPrompt(_state: DemoGraphStateType): string {
    return 'You are {step}.';
  }

  async run(
    state: DemoGraphStateType,
  ): Promise<GraphNodeUpdate<DemoGraphStateType>> {
    const calls = [
      ['ConcurStep1', 'first'],
      ['ConcurStep2', 'second'],
      ['ConcurStep3', 'third'],
      ['ConcurStep4', 'fourth'],
    ] as const;
    const systemPrompt = this.getPrompt(state);
    const taskPrompt =
      'Confirm in one short sentence that the {ordinal} concurrent follow-up task is complete.';
    const results = await Promise.all(
      calls.map(([step, ordinal]) =>
        this.llmGateway.generate(
          systemPrompt.replace('{step}', step),
          taskPrompt.replace('{ordinal}', ordinal),
          this.llmConfig(),
        ),
      ),
    );
    return {
      ...this.save({
        task: Object.fromEntries(
          calls.map(([step], index) => [step, results[index]!.value]),
        ),
      }),
      tokens: results.reduce(
        (total, result) => addTokenUsage(total, result.usage),
        emptyTokenUsage(),
      ),
    };
  }
}
