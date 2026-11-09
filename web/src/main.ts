import "./style.css";
import { start } from "./app/app";

start().catch((err: unknown) => {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = err instanceof Error ? err.message : String(err);
    status.className = "err";
  }
  document.getElementById("loading")?.setAttribute("hidden", "");
});
