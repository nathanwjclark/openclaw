import path from "node:path";
import { resolveTaskStateDir } from "../tasks/task-registry.paths.js";

export function resolveExtrapolationStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTaskStateDir(env);
}

export function resolveExtrapolationDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveExtrapolationStateDir(env), "extrapolation");
}

export function resolveExtrapolationSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveExtrapolationDir(env), "graphs.sqlite");
}
