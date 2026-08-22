import {
  GraphNode,
  type GraphNodeUpdate,
} from 'ezgraph';
import type { DemoGraphStateType } from '../demo-graph.state.js';

/** Fans out to the joke-writing child nodes. */
export class ParallelNode extends GraphNode<DemoGraphStateType> {
  getPrompt(_state: DemoGraphStateType): string {
    return 'Fan out to the child joke writers.';
  }

  run(_state: DemoGraphStateType): GraphNodeUpdate<DemoGraphStateType> {
    return {};
  }
}
