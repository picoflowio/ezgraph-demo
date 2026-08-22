import { createGraphStateAnnotation } from "ezgraph";
import { WeatherNode } from "./nodes/weather.node.js";

export const DemoGraphState = createGraphStateAnnotation(WeatherNode.name);

export type DemoGraphStateType = typeof DemoGraphState.State;
