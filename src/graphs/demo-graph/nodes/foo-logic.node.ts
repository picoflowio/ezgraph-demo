import {
  GraphNode,
  type GraphNodeUpdate,
} from "ezgraph";
import type { DemoGraphStateType } from "../demo-graph.state.js";

/** Persists the demo's intermediate Foo logic result. */
export class FooLogicNode extends GraphNode<DemoGraphStateType, { fooData?: string }> {
  getPrompt(_state: DemoGraphStateType): string {
    return "Foo logic does not use a prompt.";
  }

  run(_state: DemoGraphStateType): GraphNodeUpdate<DemoGraphStateType> {
    console.log("Running FooLogicNode...");
    return this.save({ fooData: "fooValue" });
  }
}
