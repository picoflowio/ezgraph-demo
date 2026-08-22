import {
  GraphNode,
  type GraphNodeUpdate,
} from "ezgraph";
import type { DemoGraphStateType } from "../demo-graph.state.js";

/** Persists the demo's intermediate Goo logic result. */
export class GooLogicNode extends GraphNode<DemoGraphStateType, { gooData?: string }> {
  getPrompt(_state: DemoGraphStateType): string {
    return "Goo logic does not use a prompt.";
  }

  run(_state: DemoGraphStateType): GraphNodeUpdate<DemoGraphStateType> {
    console.log("Running GooLogicNode...");
    return this.save({ gooData: "gooValue" });
  }
}
