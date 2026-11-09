interface DragStats {
  kind: string;
  firstZoneMs: number | null;
  allZonesMs: number | null;
  arrivals: number[];
  routeMs: number[];
  frameWork: number[];
  planMs?: number;
  commitServerMs?: number;
  dropToViewMs?: number;
}

interface Window {
  d2Stats?: { drags: DragStats[]; last: DragStats | null; current?: { done: boolean } };
  editor?: import("./editor/editor").Editor;
}
