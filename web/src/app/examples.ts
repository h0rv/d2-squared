import architecture from "../../../examples/architecture.d2?raw";
import erd from "../../../examples/erd.d2?raw";
import family from "../../../examples/family.d2?raw";
import orderStates from "../../../examples/order-states.d2?raw";
import org from "../../../examples/org.d2?raw";

export interface Example {
  id: string;
  title: string;
  hint: string;
  source: string;
}

export const EXAMPLES: readonly Example[] = [
  { id: "architecture", title: "Cloud architecture", hint: "Drag a box into another group.", source: architecture },
  { id: "erd", title: "Shop database", hint: "Drag the end of an arrow onto a column of another table.", source: erd },
  { id: "org", title: "Org chart", hint: "Drag the start of an arrow onto a different manager.", source: org },
  { id: "states", title: "Order states", hint: "Drag the end of an arrow to a different state.", source: orderStates },
  { id: "family", title: "Family tree", hint: "Drag a person onto a different parent.", source: family },
];

export const DEFAULT_HINT = "Drag a box to move it, or drag the end of an arrow to reconnect it.";
