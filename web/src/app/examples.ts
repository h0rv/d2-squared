import architecture from "../../../examples/architecture.d2?raw";
import erd from "../../../examples/erd.d2?raw";
import family from "../../../examples/family.d2?raw";
import orderStates from "../../../examples/order-states.d2?raw";
import org from "../../../examples/org.d2?raw";

export interface Example {
  id: string;
  title: string;
  source: string;
}

export const EXAMPLES: readonly Example[] = [
  { id: "architecture", title: "Architecture", source: architecture },
  { id: "erd", title: "Database", source: erd },
  { id: "org", title: "Org chart", source: org },
  { id: "states", title: "States", source: orderStates },
  { id: "family", title: "Family tree", source: family },
];
